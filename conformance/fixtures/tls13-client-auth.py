"""Initial optional client authentication; pinned peer verifies native Finished."""
import base64
import hashlib
import json
import socket
import sys
import threading
import time

dependencies, directory, scenario = sys.argv[1:]
sys.path.insert(0, dependencies)
import tlslite
from tlslite.api import HandshakeSettings, TLSConnection, X509, X509CertChain, parsePEMKey
from tlslite.constants import ContentType, ExtensionType, HandshakeType
from tlslite.messages import CertificateRequest

assert tlslite.__version__ == "0.8.2", "Run bun run test:tls:setup"
assert scenario in ("none", "optional")
SOCKET_TIMEOUT_SECONDS = 4
MAX_HTTP_BYTES = 16384
MAX_HANDSHAKE_MESSAGES = 8
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


class ObservedTLS(TLSConnection):
    def __init__(self, raw, record):
        super().__init__(raw)
        self.record = record
        self.handshaking = True

    def _getNextRecord(self):
        for result in super()._getNextRecord():
            if self.handshaking and isinstance(result, tuple):
                header, parser = result
                data = bytes(parser.bytes[parser.index:])
                if header.type == ContentType.handshake:
                    assert data, "Empty handshake message"
                    if data[0] in (HandshakeType.certificate,
                                   HandshakeType.certificate_verify,
                                   HandshakeType.finished):
                        self.record["authentication"].append(data.hex())
                        assert len(self.record["authentication"]) <= MAX_HANDSHAKE_MESSAGES
            yield result

    def _queue_message(self, message):
        if isinstance(message, CertificateRequest):
            # Keep this initial request independent of certificate compression
            # and record the exact bytes entering the authenticated transcript.
            message.extensions = [item for item in message.extensions
                                  if item.extType == ExtensionType.signature_algorithms]
            original_write = message.write

            def serialize():
                data = original_write()
                self.record["requests"].append(bytes(data).hex())
                return data
            message.write = serialize
        super()._queue_message(message)


settings = HandshakeSettings()
settings.minVersion = settings.maxVersion = (3, 4)
settings.cipherNames = ["aes128gcm"]
settings.eccCurves = settings.keyShares = ["x25519"]
settings.defaultCurve = "x25519"
settings.dhGroups = []
settings.ticketKeys = []
settings.ticket_count = 0
settings.certificate_compression_send = []
settings.certificate_compression_receive = []
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(8)
port = listener.getsockname()[1]


def serve(raw):
    record = {"requests": [], "authentication": [], "session": None,
              "group": None, "http": [], "upgrades": [], "errors": []}
    records.append(record)
    raw.settimeout(SOCKET_TIMEOUT_SECONDS)
    connection = ObservedTLS(raw, record)
    try:
        # reqCert requests, but does not require, an identity. The pinned peer
        # accepts an empty chain and independently verifies the client's Finished.
        connection.handshakeServer(certChain=X509CertChain([leaf, authority]),
                                   privateKey=key, settings=settings,
                                   reqCert=scenario == "optional", alpn=[b"http/1.1"])
        connection.handshaking = False
        record["session"] = {"version": list(connection.version),
                             "cipher": connection.session.cipherSuite,
                             "resumed": connection.resumed}
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
        record["http"].append(path)
        if headers.get("upgrade", "").lower() == "websocket":
            record["upgrades"].append({"path": path,
                                       "protocol": headers.get("sec-websocket-protocol")})
            accept = base64.b64encode(hashlib.sha1(
                (headers["sec-websocket-key"] + WEBSOCKET_GUID).encode()).digest()).decode()
            connection.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                              "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept +
                              "\r\nSec-WebSocket-Protocol: xmpp\r\n\r\n").encode())
            assert connection.read(min=1, max=MAX_HTTP_BYTES), "Missing WebSocket application data"
            connection.write(b"\x88\x00")
        else:
            body = (f'<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link '
                    f'rel="urn:xmpp:alt-connections:websocket" href="wss://localhost:{port}/xmpp"/>'
                    '</XRD>').encode() if path == "/.well-known/host-meta" else b"authenticated client-auth peer"
            connection.write((f"HTTP/1.1 200 OK\r\nContent-Type: application/xrd+xml\r\n"
                              f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode() + body)
    except Exception as error:
        record["errors"].append({"name": type(error).__name__, "message": str(error)})
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
            assert not sockets, "Client-auth peer did not settle"
        print(json.dumps({"type": "snapshot", "records": records}), flush=True)
    elif command.strip() == "stop":
        break
listener.close()
for raw in list(sockets):
    raw.close()
