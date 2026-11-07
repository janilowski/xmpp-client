"""Independent downgrade peer; disposable RSA keys and X25519 only, never production."""
import base64
import hashlib
import json
import socket
import sys
import threading
import time

dependencies, directory, mode = sys.argv[1:]
sys.path.insert(0, dependencies)
import tlslite
from tlslite.api import HandshakeSettings, TLSConnection, X509, X509CertChain, parsePEMKey
from tlslite.constants import ContentType, HandshakeType
from tlslite.messages import ServerHello, ServerKeyExchange

assert tlslite.__version__ == "0.8.2", "Run bun run test:tls:setup"
assert mode in ("ordinary", "near-match", "tls12-sentinel", "tls11-sentinel")
SOCKET_TIMEOUT_SECONDS = 4
ALERT_DRAIN_SECONDS = 0.2
SERVER_HELLO_PAUSE_SECONDS = 0.05
MAX_HTTP_BYTES = 16384
MAX_TLS_RECORD_BYTES = 18432
TLS_RECORD_HEADER_BYTES = 5
TLS_ALERT_BYTES = 2
TLS12_SENTINEL = bytes.fromhex("444f574e47524401")
TLS11_SENTINEL = bytes.fromhex("444f574e47524400")
NEAR_MATCH = bytes.fromhex("444f574e47524402")
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

# Change the random before key-exchange construction/signing. Mutating only
# write() would leave ServerKeyExchange signed over a different random.
original_create = ServerHello.create
def create_hello(self, *args, **kwargs):
    result = original_create(self, *args, **kwargs)
    if mode == "tls12-sentinel":
        self.random[-8:] = TLS12_SENTINEL
    elif mode == "tls11-sentinel":
        self.random[-8:] = TLS11_SENTINEL
    elif mode == "near-match":
        self.random[-8:] = NEAR_MATCH
    return result
ServerHello.create = create_hello


class ObservedSocket:
    def __init__(self, raw, record):
        self.raw = raw
        self.record = record
        self.pending = bytearray()

    def __getattr__(self, name):
        return getattr(self.raw, name)

    def close(self):
        # The fixture owns closure so an early refusal racing a server write
        # cannot erase the client's unread plaintext fatal alert.
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
            # This peer fixes c02f: encrypted GCM alerts have nonce/tag
            # overhead (RFC 5288 §3), so a two-byte alert is plaintext.
            # A TLS 1.3 compatibility CCS alone does not activate keys
            # (RFC 9846 §5). This is not a general TLS decryption oracle.
            if kind == ContentType.alert and length == TLS_ALERT_BYTES:
                self.record["alerts"].append(list(payload))
            del self.pending[:TLS_RECORD_HEADER_BYTES + length]
        return data


class ObservedTLS(TLSConnection):
    def __init__(self, raw, record):
        super().__init__(raw)
        self.record = record

    def _getNextRecord(self):
        for result in super()._getNextRecord():
            if isinstance(result, tuple):
                header, parser = result
                data = bytes(parser.bytes[parser.index:])
                if header.type == ContentType.handshake and data[0] == HandshakeType.client_hello:
                    self.record["hellos"].append(data.hex())
            yield result

    def _sendMsg(self, message, *args, **kwargs):
        if isinstance(message, ServerHello):
            original_write = message.write
            def serialize():
                data = original_write()
                self.record["responses"].append(bytes(data).hex())
                return data
            message.write = serialize
        yield from super()._sendMsg(message, *args, **kwargs)
        if isinstance(message, ServerHello):
            self.sock.flush()
            time.sleep(SERVER_HELLO_PAUSE_SECONDS)
        elif isinstance(message, ServerKeyExchange):
            self.record["group"] = message.named_curve


settings = HandshakeSettings()
settings.minVersion = settings.maxVersion = (3, 3)
settings.cipherNames = ["aes128gcm"]
settings.keyExchangeNames = ["ecdhe_rsa"]
settings.rsaSigHashes = ["sha256"]
settings.rsaSchemes = ["pkcs1"]
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
        connection.handshakeServer(certChain=X509CertChain([leaf, authority]),
                                   privateKey=key, settings=settings,
                                   alpn=[b"http/1.1"])
        record["session"] = {"version": list(connection.version),
                             "cipher": connection.session.cipherSuite,
                             "resumed": connection.resumed}
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
                    '</XRD>').encode() if path == "/.well-known/host-meta" else b"authenticated downgrade peer"
            connection.write((f"HTTP/1.1 200 OK\r\nContent-Type: application/xrd+xml\r\n"
                              f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode() + body)
    except Exception as error:
        record["errors"].append({"name": type(error).__name__, "message": str(error)})
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
            assert not sockets, "Downgrade peer did not settle"
        print(json.dumps({"type": "snapshot", "records": records}), flush=True)
    elif command.strip() == "stop":
        break
listener.close()
for raw in list(sockets):
    raw.close()
