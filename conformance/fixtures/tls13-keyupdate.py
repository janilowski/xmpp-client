"""Authenticated KeyUpdate observer using the pinned independent TLS peer."""
import base64
import hashlib
import json
import os
import socket
import sys
import xml.etree.ElementTree as ET

dependencies, directory, scenario, protocol = sys.argv[1:]
sys.path.insert(0, dependencies)
import tlslite
from tlslite.api import TLSConnection, X509, X509CertChain, parsePEMKey, HandshakeSettings
from tlslite.constants import ContentType, HandshakeType
from tlslite.errors import TLSAbruptCloseError
from tlslite.messages import KeyUpdate

assert tlslite.__version__ == "0.8.2", "Run bun run test:tls:setup"
assert scenario in ("not-requested", "requested", "invalid")
assert protocol in ("control", "xmpp")
SOCKET_TIMEOUT_SECONDS = 4
MAX_BYTES = 16384
MAX_FRAMES = 32
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
FRAMING = "urn:ietf:params:xml:ns:xmpp-framing"
SASL = "urn:ietf:params:xml:ns:xmpp-sasl"
STREAM = "http://etherx.jabber.org/streams"
BIND = "urn:ietf:params:xml:ns:xmpp-bind"
request_type = {"not-requested": 0, "requested": 1, "invalid": 2}[scenario]
records = {"version": None, "cipher": None, "resumed": None, "group": None,
           "before": [], "sent": [], "received": [], "after": [],
           "eof": False, "errors": []}
observing = False

with open(os.path.join(directory, "leaf.pem")) as source:
    leaf = X509().parse(source.read())
with open(os.path.join(directory, "ca.pem")) as source:
    authority = X509().parse(source.read())
with open(os.path.join(directory, "key.pem")) as source:
    key = parsePEMKey(source.read(), private=True)


class ObservedSocket:
    def __init__(self, raw):
        self.raw = raw

    def __getattr__(self, name):
        return getattr(self.raw, name)

    def recv(self, size):
        data = self.raw.recv(size)
        if not data:
            records["eof"] = True
        return data

    def close(self):
        # Only parent release may close this peer, never TLS error recovery.
        pass


class ObservedTLS(TLSConnection):
    def _getNextRecord(self):
        for result in super()._getNextRecord():
            if observing and isinstance(result, tuple):
                header, parser = result
                records["received"].append({"type": header.type,
                                            "bytes": bytes(parser.bytes[parser.index:]).hex()})
                assert len(records["received"]) <= MAX_FRAMES
            yield result

    def _sendMsg(self, message, *args, **kwargs):
        yield from super()._sendMsg(message, *args, **kwargs)
        if observing and isinstance(message, KeyUpdate):
            records["sent"].append(bytes(message.write()).hex())


class XMPP:
    def __init__(self, connection):
        self.connection = connection
        self.pending = b""

    def exact(self, length):
        while len(self.pending) < length:
            data = self.connection.read(min=1, max=MAX_BYTES)
            assert data, "EOF before application exchange"
            self.pending += data
            assert len(self.pending) <= 2 * MAX_BYTES
        output, self.pending = self.pending[:length], self.pending[length:]
        return output

    def upgrade(self):
        while b"\r\n\r\n" not in self.pending:
            data = self.connection.read(min=1, max=MAX_BYTES)
            assert data, "EOF before HTTP upgrade"
            self.pending += data
            assert len(self.pending) <= MAX_BYTES
        header, self.pending = self.pending.split(b"\r\n\r\n", 1)
        lines = header.decode("ascii").split("\r\n")
        assert lines[0] == "GET /xmpp HTTP/1.1"
        headers = {name.lower(): value.strip() for name, value in
                   (line.split(":", 1) for line in lines[1:])}
        assert headers["sec-websocket-protocol"] == "xmpp"
        accept = base64.b64encode(hashlib.sha1(
            (headers["sec-websocket-key"] + WEBSOCKET_GUID).encode()).digest()).decode()
        self.connection.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                               "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept +
                               "\r\nSec-WebSocket-Protocol: xmpp\r\n\r\n").encode())

    def send(self, body):
        payload = body.encode()
        assert len(payload) < MAX_BYTES
        header = bytes([0x81, len(payload)]) if len(payload) < 126 else \
            b"\x81\x7e" + len(payload).to_bytes(2, "big")
        self.connection.write(header + payload)

    def message(self, body):
        self.send('<message xmlns="jabber:client" from="friend@example.test" '
                  'to="user@example.test/r"><body>' + body + '</body></message>')

    def receive(self):
        payload = bytearray()
        started = False
        for _ in range(MAX_FRAMES):
            first, second = self.exact(2)
            assert not first & 0x70 and second & 0x80
            opcode, length = first & 15, second & 127
            if length == 126:
                length = int.from_bytes(self.exact(2), "big")
            assert length < MAX_BYTES
            mask = self.exact(4)
            fragment = bytes(value ^ mask[index % 4]
                             for index, value in enumerate(self.exact(length)))
            if opcode == 9:
                self.connection.write(bytes([0x8a, len(fragment)]) + fragment)
                continue
            assert opcode == (0 if started else 1)
            started = True
            payload.extend(fragment)
            assert len(payload) < MAX_BYTES
            if first & 0x80:
                return ET.fromstring(payload.decode())
        raise AssertionError("WebSocket frame budget exceeded")

    def authenticate(self):
        self.upgrade()
        authenticated = False
        bound = False
        for _ in range(MAX_FRAMES):
            element = self.receive()
            if element.tag == "{" + FRAMING + "}open":
                self.send(f'<open xmlns="{FRAMING}" from="example.test" id="peer" version="1.0"/>')
                features = f'<bind xmlns="{BIND}"/>' if authenticated else \
                    f'<mechanisms xmlns="{SASL}"><mechanism>PLAIN</mechanism></mechanisms>'
                self.send(f'<features xmlns="{STREAM}">{features}</features>')
            elif element.tag == "{" + SASL + "}auth":
                assert element.attrib["mechanism"] == "PLAIN"
                assert base64.b64decode(element.text) == b"\x00user\x00password"
                authenticated = True
                self.send(f'<success xmlns="{SASL}"/>')
            elif element.tag == "{jabber:client}iq":
                assert authenticated and not bound
                assert element.find("{" + BIND + "}bind") is not None
                bound = True
                self.send(f'<iq xmlns="jabber:client" type="result" id="{element.attrib["id"]}">'
                          f'<bind xmlns="{BIND}"><jid>user@example.test/r</jid></bind></iq>')
            else:
                assert bound and element.tag == "{jabber:client}message"
                body = element.find("{jabber:client}body").text
                records["before"].append(body)
                if body == "before":
                    self.message("before-ok")
                else:
                    assert body == "ready" and records["before"] == ["before", "ready"]
                    return
        raise AssertionError("XMPP negotiation budget exceeded")


settings = HandshakeSettings()
settings.minVersion = settings.maxVersion = (3, 4)
settings.cipherNames = ["aes128gcm"]
settings.eccCurves = ["x25519"]
settings.keyShares = ["x25519"]
settings.defaultCurve = "x25519"
settings.dhGroups = []
listener = socket.socket()
listener.settimeout(SOCKET_TIMEOUT_SECONDS)
listener.bind(("127.0.0.1", 0))
listener.listen(1)
print(json.dumps({"phase": "ready", "port": listener.getsockname()[1], "tlslite": tlslite.__version__}), flush=True)
raw = None
try:
    raw, _ = listener.accept()
    raw.settimeout(SOCKET_TIMEOUT_SECONDS)
    connection = ObservedTLS(ObservedSocket(raw))
    connection.handshakeServer(certChain=X509CertChain([leaf, authority]), privateKey=key,
                               settings=settings, alpn=[b"http/1.1"])
    records.update(version=list(connection.version), cipher=connection.session.cipherSuite,
                   resumed=connection.resumed, group=connection.ecdhCurve)
    assert records["version"] == [3, 4] and records["cipher"] == 0x1301
    assert not records["resumed"] and records["group"] == 29
    xmpp = XMPP(connection) if protocol == "xmpp" else None
    if xmpp:
        xmpp.authenticate()
        assert not xmpp.pending
    else:
        assert connection.read(min=5, max=5) == b"READY"
        connection.write(b"BEFORE")
        assert connection.read(min=2, max=2) == b"GO"
        records["before"] = ["READY", "GO"]

    # Queue both records before delivery: peer send races must not become
    # setup errors or disguise whether the client accepts a later XML frame.
    observing = True
    connection.sock.buffer_writes = True
    if scenario == "invalid":
        for _ in connection._sendMsg(KeyUpdate().create(request_type)):
            pass
    else:
        for _ in connection.send_keyupdate_request(request_type):
            pass
    if xmpp:
        xmpp.message("late" if scenario == "invalid" else "challenge")
    else:
        connection.write(b"LATE" if scenario == "invalid" else b"CHALLENGE")
    connection.sock.flush()
    connection.sock.buffer_writes = False
    if scenario == "invalid":
        # Do not use read(): automatic alert recovery could send our own alert
        # or close TCP before the client's rejection and EOF are observed.
        while True:
            for result in connection._getNextRecord():
                if isinstance(result, tuple):
                    break
            header, parser = result
            if header.type == ContentType.application_data:
                records["after"].append(bytes(parser.bytes[parser.index:]).hex())
            elif header.type == ContentType.handshake:
                assert parser.get(1) == HandshakeType.key_update
                update = KeyUpdate().parse(parser)
                assert update.message_type in (0, 1)
                for _ in connection._handle_keyupdate_request(update):
                    pass
    elif xmpp:
        element = xmpp.receive()
        assert element.tag == "{jabber:client}message"
        assert element.find("{jabber:client}body").text == "after"
        records["after"].append("after")
        xmpp.message("after-ok")
    else:
        assert connection.read(min=5, max=5) == b"AFTER"
        records["after"].append("AFTER")
        connection.write(b"AFTER-OK")
except TLSAbruptCloseError:
    assert scenario == "invalid" and records["eof"]
except Exception as error:
    records["errors"].append({"name": type(error).__name__, "message": str(error)})
finally:
    print(json.dumps({"phase": "observed", "records": records}), flush=True)
    assert sys.stdin.readline().strip() == "finish"
    if raw is not None:
        raw.close()
    listener.close()
