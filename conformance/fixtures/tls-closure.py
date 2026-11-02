"""Authenticated close-notify observer, independent of application TLS code."""
import base64
import hashlib
import json
import os
import socket
import sys
import xml.etree.ElementTree as ET

dependencies, directory, version, mode, *options = sys.argv[1:]
gated = options in (["reciprocal"], ["reciprocal-eof"])
hold_eof = options == ["reciprocal-eof"]
assert not options or gated
sys.path.insert(0, dependencies)
import tlslite
from tlslite.api import TLSConnection, X509, X509CertChain, parsePEMKey, HandshakeSettings
from tlslite.constants import ContentType, AlertDescription, AlertLevel
from tlslite.messages import Alert, ServerKeyExchange
from tlslite.errors import TLSAbruptCloseError

assert tlslite.__version__ == "0.8.2", "Run bun run test:tls:setup"
assert version in ("3", "4") and mode in ("control", "xmpp", "xmpp-fatal")
SOCKET_TIMEOUT_SECONDS = 4
MAX_MESSAGE_BYTES = 16384
MAX_FRAMES = 32
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
FRAMING = "urn:ietf:params:xml:ns:xmpp-framing"
SASL = "urn:ietf:params:xml:ns:xmpp-sasl"
STREAM = "http://etherx.jabber.org/streams"
ERRORS = "urn:ietf:params:xml:ns:xmpp-streams"
BIND = "urn:ietf:params:xml:ns:xmpp-bind"
X25519 = "x25519"
records = {"version": None, "cipher": None, "ecdhCurve": None, "alerts": [], "application": [],
           "eof": False, "errors": []}
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
        # The fixture, not TLS library error recovery, owns final TCP closure.
        pass


class ObservedTLS(TLSConnection):
    def _getNextRecord(self):
        # The record layer has authenticated/decrypted these bytes, including
        # TLS 1.3's encrypted inner alert content type. Do not consume the parser.
        for result in super()._getNextRecord():
            if isinstance(result, tuple):
                header, parser = result
                if records["version"] and header.type == ContentType.alert:
                    records["alerts"].append(["received", *parser.bytes[parser.index:]])
            yield result

    def _sendMsg(self, message, *args, **kwargs):
        yield from super()._sendMsg(message, *args, **kwargs)
        if isinstance(message, ServerKeyExchange):
            # TLS 1.2 exposes the negotiated group in its signed server message.
            records["ecdhCurve"] = message.named_curve
        if records["version"] and isinstance(message, Alert):
            records["alerts"].append(["sent", *message.write()])


def exchange_xmpp(connection):
    pending = b""
    while b"\r\n\r\n" not in pending:
        data = connection.read(min=1, max=MAX_MESSAGE_BYTES)
        assert data, "EOF before HTTP upgrade"
        pending += data
        assert len(pending) <= MAX_MESSAGE_BYTES
    header, pending = pending.split(b"\r\n\r\n", 1)
    headers = {name.lower(): value.strip() for name, value in
               (line.split(":", 1) for line in header.decode("ascii").split("\r\n")[1:])}
    assert headers.get("sec-websocket-protocol") == "xmpp"
    accept = base64.b64encode(hashlib.sha1(
        (headers["sec-websocket-key"] + WEBSOCKET_GUID).encode()).digest()).decode()
    connection.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                      "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept +
                      "\r\nSec-WebSocket-Protocol: xmpp\r\n\r\n").encode())

    def exact(length):
        nonlocal pending
        while len(pending) < length:
            data = connection.read(min=1, max=MAX_MESSAGE_BYTES)
            assert data, "EOF before WebSocket message"
            pending += data
        output, pending = pending[:length], pending[length:]
        return output

    def send(text):
        payload = text.encode()
        assert len(payload) < MAX_MESSAGE_BYTES
        header = bytes([0x81, len(payload)]) if len(payload) < 126 else \
            b"\x81\x7e" + len(payload).to_bytes(2, "big")
        connection.write(header + payload)

    authenticated = False
    bound = False
    fatal = False
    for _ in range(MAX_FRAMES):
        header = exact(2)
        opcode, length = header[0] & 15, header[1] & 127
        if length == 126:
            length = int.from_bytes(exact(2), "big")
        assert length < MAX_MESSAGE_BYTES and header[1] & 128
        mask = exact(4)
        payload = bytes(value ^ mask[index % 4]
                        for index, value in enumerate(exact(length)))
        if opcode == 8:
            records["application"].append("WS_CLOSE")
            connection.write(b"\x88" + bytes([len(payload)]) + payload)
            # Withhold the server TLS alert: the client must initiate it.
            return
        assert opcode == 1
        text = payload.decode()
        records["application"].append(text)
        element = ET.fromstring(text)
        if fatal:
            assert element.tag == "{" + FRAMING + "}close", "Application output after stream error"
        if element.tag == "{" + FRAMING + "}open":
            send(f'<open xmlns="{FRAMING}" from="example.test" id="peer" version="1.0"/>')
            feature = f'<bind xmlns="{BIND}"/>' if authenticated else \
                f'<mechanisms xmlns="{SASL}"><mechanism>PLAIN</mechanism></mechanisms>'
            send(f'<features xmlns="{STREAM}">{feature}</features>')
        elif element.tag == "{" + SASL + "}auth":
            assert element.attrib["mechanism"] == "PLAIN"
            assert base64.b64decode(element.text) == b"\x00user\x00password"
            authenticated = True
            send(f'<success xmlns="{SASL}"/>')
        elif element.tag == "{jabber:client}iq":
            assert authenticated and not bound
            assert element.find("{" + BIND + "}bind") is not None
            bound = True
            identifier = element.attrib["id"]
            send(f'<iq xmlns="jabber:client" type="result" id="{identifier}">'
                 f'<bind xmlns="{BIND}"><jid>user@example.test/r</jid></bind></iq>')
        elif element.tag == "{jabber:client}message":
            assert bound
            body = element.find("{jabber:client}body").text
            if body == "probe":
                send('<message xmlns="jabber:client" from="friend@example.test" '
                     'to="user@example.test/r"><body>reply</body></message>')
            else:
                assert mode == "xmpp-fatal" and body == "fatal-trigger"
                send('<message xmlns="jabber:client"><body></message>')
                send('<message xmlns="jabber:client" from="friend@example.test" '
                     'to="user@example.test/r"><body>late</body></message>')
        elif element.tag == "{" + STREAM + "}error":
            assert mode == "xmpp-fatal"
            # Preferred local diagnostic; RFC 6120 also permits bad-format.
            conditions = [child.tag for child in element
                          if child.tag.startswith("{" + ERRORS + "}")
                          and child.tag != "{" + ERRORS + "}text"]
            assert conditions == ["{" + ERRORS + "}not-well-formed"]
            fatal = True
        elif element.tag == "{" + FRAMING + "}close":
            send(f'<close xmlns="{FRAMING}"/>')
        else:
            raise AssertionError("Unexpected XMPP element")
    raise AssertionError("WebSocket frame budget exceeded")


settings = HandshakeSettings()
settings.minVersion = settings.maxVersion = (3, int(version))
settings.cipherNames = ["aes128gcm"]
settings.keyExchangeNames = ["ecdhe_rsa"]
settings.eccCurves = [X25519]
settings.keyShares = [X25519]
settings.defaultCurve = X25519
settings.dhGroups = []
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
    connection.handshakeServer(certChain=X509CertChain([leaf, authority]),
                               privateKey=key, settings=settings, alpn=[b"http/1.1"])
    records["version"] = list(connection.version)
    records["cipher"] = connection.session.cipherSuite
    if connection.ecdhCurve is not None:
        records["ecdhCurve"] = connection.ecdhCurve
    if gated:
        print(json.dumps({"phase": "connected", "clientPort": raw.getpeername()[1]}), flush=True)
        assert sys.stdin.readline().strip() == "exchange"
    if mode == "control":
        assert connection.read(min=4, max=4) == b"PING"
        records["application"].append("PING")
        connection.write(b"PONG")
    else:
        exchange_xmpp(connection)
    # Read directly so tlslite's automatic alert response cannot hide ordering.
    for result in connection._getNextRecord():
        if isinstance(result, tuple):
            break
    header, parser = result
    assert header.type == ContentType.alert
    assert list(parser.bytes[parser.index:]) == [AlertLevel.warning, AlertDescription.close_notify]
    if gated:
        print(json.dumps({"phase": "held", "alerts": records["alerts"],
                          "eof": records["eof"]}), flush=True)
        assert sys.stdin.readline().strip() == "alert"
    for _ in connection._sendMsg(Alert().create(AlertDescription.close_notify, AlertLevel.warning)):
        pass
    connection.sock.flush()
    if gated:
        print(json.dumps({"phase": "sent", "alerts": records["alerts"]}), flush=True)
        # Keep TCP open: only the authenticated alert can release the client fd.
        assert sys.stdin.readline().strip() == "finish"
except Exception as error:
    records["errors"].append({"name": type(error).__name__, "message": str(error)})
    if (hold_eof and isinstance(error, TLSAbruptCloseError) and records["eof"]
            and not records["alerts"] and records["application"][-1:] == ["WS_CLOSE"]):
        # Observe browser receive ownership before this peer sends TCP FIN.
        print(json.dumps({"phase": "eof", "records": records}), flush=True)
        assert sys.stdin.readline().strip() == "finish"
finally:
    if raw is not None:
        raw.close()
    listener.close()
print(json.dumps(records), flush=True)
