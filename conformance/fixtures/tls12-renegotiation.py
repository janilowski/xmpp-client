"""Independent TLS 1.2 peer; dependencies live outside the application bundle."""
import base64
import hashlib
import json
import socket
import sys
import threading
import time

dependencies, directory, acknowledgement, *signature_mode = sys.argv[1:]
sys.path.insert(0, dependencies)
import tlslite
from tlslite.api import TLSConnection, X509, X509CertChain, parsePEMKey, HandshakeSettings
from tlslite.messages import ServerHello, ServerKeyExchange
from tlslite.keyexchange import KeyExchange

assert tlslite.__version__ == "0.8.2", "Unexpected TLS peer version"
assert acknowledgement in ("empty", "absent"), "Invalid acknowledgement mode"
assert len(signature_mode) <= 1, "Unexpected signature arguments"
signature_hash = signature_mode[0] if signature_mode else None
assert signature_hash in (None, "sha256", "sha1", "md5"), "Invalid signature hash"
TLS_ALERT = 21
TLS_CHANGE_CIPHER_SPEC = 20
TLS_RECORD_HEADER_BYTES = 5
MAX_TLS_RECORD_BYTES = 18432
READ_BYTES = 16384
MAX_HTTP_HEADER_BYTES = 16384
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
SOCKET_TIMEOUT_SECONDS = 4
ALERT_DRAIN_SECONDS = 0.2
SERVER_HELLO_PAUSE_SECONDS = 0.05
RENEGOTIATION_INFO = 65281
X25519 = "x25519"
records = {"hellos": [], "sessions": [], "requests": [], "upgrades": [], "alerts": [], "errors": []}
if signature_hash:
    records["signatures"] = []

    # Sign the actual parameters, even when the client did not offer this hash.
    # Changing before serialization preserves the authenticated transcript.
    original_sign = KeyExchange.signServerKeyExchange
    def sign_exchange(self, message, sigHash=None):
        original_sign(self, message, signature_hash)
        records["signatures"].append({
            "scheme": [message.hashAlg, message.signAlg],
            "input": bytes(self.clientHello.random + self.serverHello.random + message.writeParams()).hex(),
            "signature": bytes(message.signature).hex(),
        })
    KeyExchange.signServerKeyExchange = sign_exchange
condition = threading.Condition()
sockets = set()

with open(directory + "/leaf.pem") as source:
    leaf = X509().parse(source.read())
with open(directory + "/ca.pem") as source:
    authority = X509().parse(source.read())
with open(directory + "/key.pem") as source:
    key = parsePEMKey(source.read(), private=True)

# _sendMsg hashes msg.write()'s bytes. Removing the extension here preserves
# a coherent Finished transcript, unlike modifying an OpenSSL flight in transit.
original_write = ServerHello.write
def write_hello(self):
    if acknowledgement == "absent":
        self.extensions = [item for item in self.extensions if item.extType != RENEGOTIATION_INFO]
    records["hellos"].append({"version": list(self.server_version), "cipher": self.cipher_suite,
                              "extensions": [item.extType for item in self.extensions]})
    return original_write(self)
ServerHello.write = write_hello

class ObservedSocket:
    """Observe plaintext alerts independently of the TLS library's exceptions."""
    def __init__(self, raw):
        self.raw = raw
        self.pending = bytearray()
        self.encrypted = False

    def __getattr__(self, name):
        return getattr(self.raw, name)

    def close(self):
        # The fixture owns final closure so an unread peer alert survives a
        # TLS library shutdown caused by an earlier coalesced-flight write.
        pass

    def recv(self, size):
        chunk = self.raw.recv(size)
        self.pending.extend(chunk)
        while len(self.pending) >= TLS_RECORD_HEADER_BYTES:
            length = int.from_bytes(self.pending[3:TLS_RECORD_HEADER_BYTES], "big")
            assert length <= MAX_TLS_RECORD_BYTES, "Unbounded TLS record"
            if len(self.pending) < length + TLS_RECORD_HEADER_BYTES:
                break
            kind = self.pending[0]
            payload = self.pending[TLS_RECORD_HEADER_BYTES:TLS_RECORD_HEADER_BYTES + length]
            if kind == TLS_ALERT and not self.encrypted:
                assert len(payload) == 2, "Malformed plaintext alert"
                records["alerts"].append(list(payload))
            if kind == TLS_CHANGE_CIPHER_SPEC:
                self.encrypted = True
            del self.pending[:TLS_RECORD_HEADER_BYTES + length]
        return chunk

settings = HandshakeSettings()
settings.minVersion = settings.maxVersion = (3, 3)
settings.cipherNames = ["aes128gcm"]
settings.keyExchangeNames = ["ecdhe_rsa"]
settings.eccCurves = [X25519]
settings.keyShares = [X25519]
settings.defaultCurve = X25519
settings.dhGroups = []
settings.useExtendedMasterSecret = True

class ObservedConnection(TLSConnection):
    def _sendMsg(self, message, *args, **kwargs):
        yield from super()._sendMsg(message, *args, **kwargs)
        if isinstance(message, ServerHello):
            # Fragment the flight at ServerHello, permitting an early fatal
            # alert to arrive before a certificate-flight write meets a reset.
            self.sock.flush()
            time.sleep(SERVER_HELLO_PAUSE_SECONDS)
        elif isinstance(message, ServerKeyExchange):
            # TLS 1.2's server connection does not populate ecdhCurve itself.
            self.fixture_curve = message.named_curve

listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(8)
port = listener.getsockname()[1]

def serve(raw):
    observed = ObservedSocket(raw)
    raw.settimeout(SOCKET_TIMEOUT_SECONDS)
    connection = ObservedConnection(observed)
    try:
        connection.handshakeServer(certChain=X509CertChain([leaf, authority]), privateKey=key, settings=settings)
        records["sessions"].append({"version": list(connection.version), "cipher": connection.session.cipherSuite,
                                    "ecdhCurve": connection.fixture_curve})
        data = bytearray()
        while b"\r\n\r\n" not in data:
            chunk = connection.read(min=1, max=READ_BYTES)
            if not chunk:
                return
            data.extend(chunk)
            assert len(data) <= MAX_HTTP_HEADER_BYTES, "Unbounded HTTP headers"
        lines = bytes(data).decode("ascii").split("\r\n")
        headers = dict(line.split(":", 1) for line in lines[1:] if ":" in line)
        headers = {name.lower(): value.strip() for name, value in headers.items()}
        path = lines[0].split(" ")[1]
        records["requests"].append(path)
        if headers.get("upgrade", "").lower() == "websocket":
            records["upgrades"].append({"path": path, "protocol": headers.get("sec-websocket-protocol")})
            accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + WEBSOCKET_GUID).encode()).digest()).decode()
            connection.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\nSec-WebSocket-Protocol: xmpp\r\n\r\n").encode())
            connection.read(min=1, max=READ_BYTES)
            connection.write(b"\x88\x00")
        else:
            body = (f'<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="wss://localhost:{port}/xmpp"/></XRD>').encode() if path == "/.well-known/host-meta" else b"probe"
            connection.write(f"HTTP/1.1 200 OK\r\nContent-Type: application/xrd+xml\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
    except Exception as error:
        records["errors"].append({"name": type(error).__name__, "message": str(error)})
        # A coalesced server flight can encounter EPIPE before TLS reads an
        # already-sent alert. Drain briefly; do not infer alerts from exceptions.
        try:
            raw.settimeout(ALERT_DRAIN_SECONDS)
            while observed.recv(READ_BYTES):
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
print(json.dumps({"type": "ready", "port": port, "tlslite": tlslite.__version__, "python": sys.version.split()[0]}), flush=True)
for command in sys.stdin:
    if command.strip() == "snapshot":
        with condition:
            deadline = time.monotonic() + SOCKET_TIMEOUT_SECONDS + 1
            while sockets and time.monotonic() < deadline:
                condition.wait(max(0, deadline - time.monotonic()))
            assert not sockets, "TLS peer did not settle"
        print(json.dumps({"type": "snapshot", "records": records}), flush=True)
    elif command.strip() == "stop":
        break
listener.close()
for raw in list(sockets):
    raw.close()
