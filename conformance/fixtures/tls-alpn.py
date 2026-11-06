"""Independent ALPN peer; disposable RSA keys and X25519 only, never production."""
import base64
import hashlib
import json
import socket
import sys
import threading
import time

dependencies, directory, version, mode = sys.argv[1:]
sys.path.insert(0, dependencies)
import tlslite
from tlslite.api import HandshakeSettings, TLSConnection, X509, X509CertChain, parsePEMKey
from tlslite.constants import ContentType, ExtensionType, HandshakeType
from tlslite.extensions import ALPNExtension
from tlslite.messages import EncryptedExtensions, ServerHello, ServerKeyExchange

assert tlslite.__version__ == "0.8.2", "Run bun run test:tls:setup"
assert version in ("3", "4") and mode in ("none", "offered", "unoffered")
SOCKET_TIMEOUT_SECONDS = 4
ALERT_DRAIN_SECONDS = 0.2
SERVER_HELLO_PAUSE_SECONDS = 0.05
MAX_HTTP_BYTES = 16384
MAX_TLS_RECORD_BYTES = 18432
TLS_RECORD_HEADER_BYTES = 5
HTTP_PROTOCOL = b"http/1.1"
UNOFFERED_PROTOCOL = b"audit-unoffered"
X25519 = "x25519"
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
records = []
condition = threading.Condition()
sockets = set()
with open(directory + "/leaf.pem") as source:
    leaf = X509().parse(source.read())
with open(directory + "/ca.pem") as source:
    authority = X509().parse(source.read())
with open(directory + "/key.pem") as source:
    key = parsePEMKey(source.read(), private=True)
assert key.key_type == "rsa", "Only disposable RSA fixture keys are permitted"


class ObservedSocket:
    def __init__(self, raw, record):
        self.raw = raw
        self.record = record
        self.pending = bytearray()
        self.encrypted = False

    def __getattr__(self, name):
        return getattr(self.raw, name)

    def close(self):
        # Retain unread TLS 1.2 alerts if an early client refusal races a
        # certificate-flight write; the fixture owns final socket closure.
        pass

    def recv(self, size):
        data = self.raw.recv(size)
        self.pending.extend(data)
        while len(self.pending) >= TLS_RECORD_HEADER_BYTES:
            length = int.from_bytes(self.pending[3:TLS_RECORD_HEADER_BYTES], "big")
            assert length <= MAX_TLS_RECORD_BYTES, "Unbounded TLS record"
            if len(self.pending) < TLS_RECORD_HEADER_BYTES + length:
                break
            kind = self.pending[0]
            payload = self.pending[TLS_RECORD_HEADER_BYTES:TLS_RECORD_HEADER_BYTES + length]
            if version == "3" and kind == ContentType.alert and not self.encrypted:
                assert len(payload) == 2, "Malformed plaintext alert"
                self.record["alerts"].append(list(payload))
            if kind == ContentType.change_cipher_spec:
                self.encrypted = True
            del self.pending[:TLS_RECORD_HEADER_BYTES + length]
        return data


class ObservedTLS(TLSConnection):
    def __init__(self, raw, record):
        super().__init__(raw)
        self.record = record

    def _getNextRecord(self):
        # Observe the defragmented ClientHello and authenticated TLS 1.3 alerts
        # before parsers consume them; no application implementation is involved.
        for result in super()._getNextRecord():
            if isinstance(result, tuple):
                header, parser = result
                data = bytes(parser.bytes[parser.index:])
                if header.type == ContentType.handshake and data[0] == HandshakeType.client_hello:
                    self.record["hellos"].append(data.hex())
                elif version == "4" and header.type == ContentType.alert:
                    self.record["alerts"].append(list(data))
            yield result

    def _select_protocol(self, message):
        message.extensions = [item for item in message.extensions if item.extType != ExtensionType.alpn]
        if mode != "none":
            selected = HTTP_PROTOCOL if mode == "offered" else UNOFFERED_PROTOCOL
            message.extensions.append(ALPNExtension().create([selected]))
        original_write = message.write

        def serialize():
            # These exact bytes enter tlslite's transcript and record layer.
            # TLS 1.2 uses ServerHello; TLS 1.3 uses EncryptedExtensions.
            data = original_write()
            self.record["responses"].append(bytes(data).hex())
            return data
        message.write = serialize

    def _sendMsg(self, message, *args, **kwargs):
        if isinstance(message, ServerHello) and version == "3":
            self._select_protocol(message)
        yield from super()._sendMsg(message, *args, **kwargs)
        if isinstance(message, ServerHello) and version == "3":
            # Let a client report a plaintext fatal alert before the remaining
            # certificate flight could encounter an early connection reset.
            self.sock.flush()
            time.sleep(SERVER_HELLO_PAUSE_SECONDS)
        elif isinstance(message, ServerKeyExchange):
            self.record["group"] = message.named_curve

    def _queue_message(self, message):
        if isinstance(message, EncryptedExtensions):
            self._select_protocol(message)
        super()._queue_message(message)


settings = HandshakeSettings()
settings.minVersion = settings.maxVersion = (3, int(version))
settings.cipherNames = ["aes128gcm"]
settings.keyExchangeNames = ["ecdhe_rsa"]
settings.eccCurves = settings.keyShares = [X25519]
settings.defaultCurve = X25519
settings.dhGroups = []
settings.ticketKeys = []
settings.ticket_count = 0
settings.useExtendedMasterSecret = True
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(8)
port = listener.getsockname()[1]


def serve(raw):
    record = {"hellos": [], "responses": [], "session": None, "group": None,
              "requests": [], "upgrades": [], "alerts": [], "errors": []}
    records.append(record)
    raw.settimeout(SOCKET_TIMEOUT_SECONDS)
    observed = ObservedSocket(raw, record)
    connection = ObservedTLS(observed, record)
    try:
        # The ordinary selector supplies a capable baseline. The response hook
        # removes it or replaces it without breaking Finished authentication.
        connection.handshakeServer(certChain=X509CertChain([leaf, authority]),
                                   privateKey=key, settings=settings,
                                   alpn=[HTTP_PROTOCOL])
        record["session"] = {"version": list(connection.version),
                             "cipher": connection.session.cipherSuite,
                             "resumed": connection.resumed}
        if version == "4":
            record["group"] = connection.ecdhCurve
        data = bytearray()
        while b"\r\n\r\n" not in data:
            chunk = connection.read(min=1, max=MAX_HTTP_BYTES)
            assert chunk, "EOF before HTTP request"
            data.extend(chunk)
            assert len(data) <= MAX_HTTP_BYTES, "Unbounded HTTP request"
        lines = bytes(data).decode("ascii").split("\r\n")
        headers = {name.lower(): value.strip() for name, value in
                   (line.split(":", 1) for line in lines[1:] if ":" in line)}
        path = lines[0].split(" ")[1]
        record["requests"].append(path)
        if headers.get("upgrade", "").lower() == "websocket":
            record["upgrades"].append({"path": path,
                                       "protocol": headers.get("sec-websocket-protocol")})
            accept = base64.b64encode(hashlib.sha1(
                (headers["sec-websocket-key"] + WEBSOCKET_GUID).encode()).digest()).decode()
            connection.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                              "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept +
                              "\r\nSec-WebSocket-Protocol: xmpp\r\n\r\n").encode())
            connection.read(min=1, max=MAX_HTTP_BYTES)
            connection.write(b"\x88\x00")
        else:
            body = (f'<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link '
                    f'rel="urn:xmpp:alt-connections:websocket" href="wss://localhost:{port}/xmpp"/>'
                    '</XRD>').encode() if path == "/.well-known/host-meta" else b"authenticated ALPN peer"
            connection.write((f"HTTP/1.1 200 OK\r\nContent-Type: application/xrd+xml\r\n"
                              f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode() + body)
    except Exception as error:
        record["errors"].append({"name": type(error).__name__, "message": str(error)})
        if version == "3":
            try:
                raw.settimeout(ALERT_DRAIN_SECONDS)
                while observed.recv(MAX_HTTP_BYTES):
                    pass
            except (OSError, TimeoutError):
                pass
    finally:
        raw.close()
        with condition:
            sockets.discard(raw)
            condition.notify_all()


def accept_connections():
    while True:
        try:
            raw, _ = listener.accept()
        except OSError:
            return
        with condition:
            sockets.add(raw)
        threading.Thread(target=serve, args=(raw,), daemon=True).start()


threading.Thread(target=accept_connections, daemon=True).start()
print(json.dumps({"type": "ready", "port": port, "tlslite": tlslite.__version__}), flush=True)
for command in sys.stdin:
    if command.strip() == "snapshot":
        with condition:
            deadline = time.monotonic() + SOCKET_TIMEOUT_SECONDS + 1
            while sockets and time.monotonic() < deadline:
                condition.wait(max(0, deadline - time.monotonic()))
            assert not sockets, "ALPN peer did not settle"
        print(json.dumps({"type": "snapshot", "records": records}), flush=True)
    elif command.strip() == "stop":
        break
listener.close()
for raw in list(sockets):
    raw.close()
