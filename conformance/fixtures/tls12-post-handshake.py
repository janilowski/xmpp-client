"""Authenticated unsafe renegotiation peer, not a general TLS implementation."""
import base64
import copy
import hashlib
import json
import os
import socket
import sys
import xml.etree.ElementTree as ET
from xml.sax.saxutils import quoteattr

dependencies, directory, scenario, protocol, abort_mode = sys.argv[1:]
sys.path.insert(0, dependencies)
import tlslite
from tlslite.api import TLSConnection, X509, X509CertChain, parsePEMKey, HandshakeSettings
from tlslite.constants import ContentType, HandshakeType, ExtensionType, AlertDescription, AlertLevel
from tlslite.errors import TLSAbruptCloseError
from tlslite.extensions import RenegotiationInfoExtension
from tlslite.messages import Alert, ClientHello, Finished, HelloRequest, ServerHello, ServerKeyExchange

assert tlslite.__version__ == "0.8.2", "Run bun run test:tls:setup"
assert scenario in ("absent", "wrong-client", "wrong-server", "correct")
assert protocol in ("control", "xmpp")
assert abort_mode in ("withheld", "queued")
assert scenario != "correct" or abort_mode == "queued"
MAX_BYTES = 16384
MAX_FRAMES = 64
MAX_MESSAGES = 16
SOCKET_TIMEOUT_SECONDS = 4
VERIFY_DATA_BYTES = 12
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
FRAMING = "urn:ietf:params:xml:ns:xmpp-framing"
SASL = "urn:ietf:params:xml:ns:xmpp-sasl"
STREAM = "http://etherx.jabber.org/streams"
BIND = "urn:ietf:params:xml:ns:xmpp-bind"
records = {"initial": {}, "application": [], "renegotiation": {},
           "alerts": [], "sentAlerts": [], "applicationAfterViolation": [], "eof": False, "errors": []}


class ObservedSocket:
    def __init__(self, raw):
        self.raw = raw

    def __getattr__(self, name):
        return getattr(self.raw, name)

    def close(self):
        # Keep TCP open until the parent explicitly releases the fixture.
        pass

    def recv(self, size):
        data = self.raw.recv(size)
        if not data:
            records["eof"] = True
        return data


class ObservedTLS(TLSConnection):
    def _sendMsgThroughSocket(self, message):
        # Capture the serialized message handed to authenticated record output,
        # not the intended extension object's pre-serialization properties.
        value = bytes(message.write())
        if message.contentType == ContentType.handshake and value[0] == HandshakeType.server_hello:
            target = records["renegotiation"] if records["renegotiation"] else records["initial"]
            target["serverHello"] = value.hex()
        if message.contentType == ContentType.alert:
            records["sentAlerts"].append(list(value))
        yield from super()._sendMsgThroughSocket(message)

    def _getNextRecord(self):
        for result in super()._getNextRecord():
            if isinstance(result, tuple):
                header, parser = result
                value = bytes(parser.bytes[parser.index:])
                if header.type == ContentType.handshake and value[0] == HandshakeType.finished:
                    assert len(value) == 4 + VERIFY_DATA_BYTES
                    records["initial"]["clientFinished"] = value[4:].hex()
                if header.type == ContentType.alert:
                    records["alerts"].append(list(value))
            yield result

    def _sendMsg(self, message, *args, **kwargs):
        yield from super()._sendMsg(message, *args, **kwargs)
        if isinstance(message, ServerHello) and not records["renegotiation"]:
            self.initial_hello = copy.deepcopy(message)
        if isinstance(message, ServerKeyExchange):
            records["initial"]["group"] = message.named_curve
            records["initial"]["signature"] = [message.hashAlg, message.signAlg]
        if isinstance(message, Finished):
            assert len(message.verify_data) == VERIFY_DATA_BYTES
            records["initial"]["serverFinished"] = bytes(message.verify_data).hex()


def exchange_xmpp(connection):
    pending = b""
    while b"\r\n\r\n" not in pending:
        data = connection.read(min=1, max=MAX_BYTES)
        assert data, "EOF before HTTP upgrade"
        pending += data
        assert len(pending) <= MAX_BYTES
    header, pending = pending.split(b"\r\n\r\n", 1)
    headers = {name.lower(): value.strip() for name, value in
               (line.split(":", 1) for line in header.decode("ascii").split("\r\n")[1:])}
    assert headers["sec-websocket-protocol"] == "xmpp"
    accept = base64.b64encode(hashlib.sha1(
        (headers["sec-websocket-key"] + WEBSOCKET_GUID).encode()).digest()).decode()
    connection.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                      "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept +
                      "\r\nSec-WebSocket-Protocol: xmpp\r\n\r\n").encode())

    def exact(length):
        nonlocal pending
        while len(pending) < length:
            data = connection.read(min=1, max=MAX_BYTES)
            assert data, "EOF before WebSocket message"
            pending += data
        result, pending = pending[:length], pending[length:]
        return result

    def send(text):
        value = text.encode()
        assert len(value) < MAX_BYTES
        header = bytes([0x81, len(value)]) if len(value) < 126 else \
            b"\x81\x7e" + len(value).to_bytes(2, "big")
        connection.write(header + value)

    def receive_message():
        # Handle legal fragmentation and control frames without depending on
        # a particular runtime's choice of WebSocket record boundaries.
        fragments = None
        for _ in range(MAX_FRAMES):
            header = exact(2)
            assert not header[0] & 0x70 and header[1] & 128
            final, opcode, length = bool(header[0] & 128), header[0] & 15, header[1] & 127
            if length == 126:
                length = int.from_bytes(exact(2), "big")
            elif length == 127:
                length = int.from_bytes(exact(8), "big")
            assert length < MAX_BYTES
            mask = exact(4)
            payload = bytes(value ^ mask[index % 4] for index, value in enumerate(exact(length)))
            if opcode in (9, 10):
                assert final and length <= 125
                if opcode == 9:
                    connection.write(bytes([0x8a, length]) + payload)
                continue
            if opcode == 1:
                assert fragments is None
                fragments = bytearray()
            else:
                assert opcode == 0 and fragments is not None
            fragments.extend(payload)
            assert len(fragments) < MAX_BYTES
            if final:
                return fragments.decode()
        raise AssertionError("WebSocket frame budget exceeded")

    authenticated = bound = False
    for _ in range(MAX_MESSAGES):
        text = receive_message()
        records["application"].append(text)
        element = ET.fromstring(text)
        if element.tag == "{" + FRAMING + "}open":
            send(f'<open xmlns="{FRAMING}" from="example.test" id="peer" version="1.0"/>')
            feature = f'<bind xmlns="{BIND}"/>' if authenticated else \
                f'<mechanisms xmlns="{SASL}"><mechanism>PLAIN</mechanism></mechanisms>'
            send(f'<features xmlns="{STREAM}">{feature}</features>')
        elif element.tag == "{" + SASL + "}auth":
            assert element.attrib["mechanism"] == "PLAIN"
            assert base64.b64decode(element.text, validate=True) == b"\x00user\x00password"
            authenticated = True
            send(f'<success xmlns="{SASL}"/>')
        elif element.tag == "{jabber:client}iq":
            assert authenticated and not bound
            assert element.find("{" + BIND + "}bind") is not None
            bound = True
            send(f'<iq xmlns="jabber:client" type="result" id={quoteattr(element.attrib["id"])}>'
                 f'<bind xmlns="{BIND}"><jid>user@example.test/r</jid></bind></iq>')
        elif element.tag == "{jabber:client}message":
            assert bound
            body = element.find("{jabber:client}body").text
            if body == "probe":
                send('<message xmlns="jabber:client" from="friend@example.test" '
                     'to="user@example.test/r"><body>reply</body></message>')
            else:
                assert body == "renegotiate"
                return
        else:
            raise AssertionError("Unexpected XMPP element")
    raise AssertionError("XMPP frame budget exceeded")


with open(os.path.join(directory, "leaf.pem")) as source:
    leaf = X509().parse(source.read())
with open(os.path.join(directory, "ca.pem")) as source:
    root = X509().parse(source.read())
with open(os.path.join(directory, "key.pem")) as source:
    key = parsePEMKey(source.read(), private=True)
settings = HandshakeSettings()
settings.minVersion = settings.maxVersion = (3, 3)
settings.cipherNames = ["aes128gcm"]
settings.keyExchangeNames = ["ecdhe_rsa"]
settings.eccCurves = settings.keyShares = ["x25519"]
settings.defaultCurve = "x25519"
settings.dhGroups = []
settings.rsaSigHashes = ["sha256"]
settings.rsaSchemes = ["pkcs1"]
settings.useExtendedMasterSecret = True
listener = socket.socket()
listener.settimeout(SOCKET_TIMEOUT_SECONDS)
listener.bind(("127.0.0.1", 0))
listener.listen(1)
print(json.dumps({"port": listener.getsockname()[1], "tlslite": tlslite.__version__}), flush=True)
raw = None
try:
    raw, _ = listener.accept()
    raw.settimeout(SOCKET_TIMEOUT_SECONDS)
    connection = ObservedTLS(ObservedSocket(raw))
    connection.handshakeServer(certChain=X509CertChain([leaf, root]), privateKey=key, settings=settings)
    records["initial"]["version"] = list(connection.version)
    records["initial"]["cipher"] = connection.session.cipherSuite
    initial_info = connection.initial_hello.getExtension(ExtensionType.renegotiation_info)
    assert initial_info is not None and not initial_info.renegotiated_connection
    assert connection.extendedMasterSecret
    records["initial"]["info"] = ""
    records["initial"]["ems"] = True
    if protocol == "xmpp":
        exchange_xmpp(connection)
    else:
        assert connection.read(min=4, max=4) == b"PING"
        connection.write(b"PONG")
        assert connection.read(min=2, max=2) == b"GO"

    # HelloRequest is encrypted under the current keys and excluded from hashes.
    records["renegotiation"]["decision"] = "requested"
    for _ in connection._sendMsg(HelloRequest().create(), update_hashes=False):
        pass
    connection.sock.flush()
    for result in connection._getNextRecord():
        if isinstance(result, tuple):
            break
    header, parser = result
    if header.type == ContentType.alert:
        records["renegotiation"]["decision"] = "declined"
    else:
        assert header.type == ContentType.handshake and parser.get(1) == HandshakeType.client_hello
        records["renegotiation"]["decision"] = "attempted"
        hello = ClientHello().parse(parser)
        client_info = hello.getExtension(ExtensionType.renegotiation_info)
        records["renegotiation"]["clientInfo"] = None if client_info is None else bytes(client_info.renegotiated_connection).hex()
        records["renegotiation"]["ciphers"] = hello.cipher_suites

        # Retain the original valid TLS 1.2 parameters; change only the RI policy.
        second = copy.deepcopy(connection.initial_hello)
        second.random = bytearray(os.urandom(32))
        second.session_id = bytearray()
        second.extensions = [item for item in second.extensions if item.extType != ExtensionType.renegotiation_info]
        binding = bytearray.fromhex(records["initial"]["clientFinished"] + records["initial"]["serverFinished"])
        assert len(binding) == 2 * VERIFY_DATA_BYTES
        if scenario != "absent":
            if scenario != "correct":
                binding[0 if scenario == "wrong-client" else VERIFY_DATA_BYTES] ^= 1
            second.extensions.append(RenegotiationInfoExtension().create(binding))
        records["renegotiation"]["serverInfo"] = None if scenario == "absent" else binding.hex()
        # Queued-abort controls distinguish RI validation from a malformed
        # ServerHello. Closure tests withhold every peer alert and TCP FIN.
        connection.sock.buffer_writes = True
        for _ in connection._sendMsg(second, update_hashes=False):
            pass
        if abort_mode == "queued":
            for _ in connection._sendMsg(Alert().create(AlertDescription.internal_error, AlertLevel.fatal)):
                pass
        connection.sock.flush()
        connection.sock.buffer_writes = False
        for result in connection._getNextRecord():
            if isinstance(result, tuple):
                break
        header, parser = result
        assert header.type == ContentType.alert
    print(json.dumps({"phase": "alert", "alerts": records["alerts"]}), flush=True)
    # Never respond after the client alert or close TCP before parent release.
    # Only withheld mode proves closure independent of a peer TLS abort.
    while True:
        for result in connection._getNextRecord():
            if isinstance(result, tuple):
                break
        header, parser = result
        assert header.type == ContentType.application_data
        records["applicationAfterViolation"].append(bytes(parser.bytes[parser.index:]).hex())
        print(json.dumps({"phase": "application-after-refusal"}), flush=True)
except TLSAbruptCloseError:
    assert records["eof"]
    if records["renegotiation"].get("decision") == "requested":
        records["renegotiation"]["decision"] = "declined"
except Exception as error:
    records["errors"].append({"name": type(error).__name__, "message": str(error)})
finally:
    print(json.dumps({"phase": "observed", "records": records}), flush=True)
    assert sys.stdin.readline().strip() == "finish"
    if raw is not None:
        raw.close()
    listener.close()
