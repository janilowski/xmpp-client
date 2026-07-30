import { createPrivateKey, X509Certificate } from "node:crypto";

import { EventEmitter } from "../../events/index.js";
import { makeSelfSignedCertificate } from "../../../test/helpers.js";

import Socket from "../lib/Socket.js";

globalThis.WebSocket = EventEmitter;

test("secure", () => {
  const socket = new Socket();

  expect(socket.secure).toBe(false);

  socket.connect("ws://example.com/foo");
  expect(socket.secure).toBe(false);

  socket.connect("ws://localhost/foo");
  expect(socket.secure).toBe(true);

  socket.connect("ws://127.0.0.1/foo");
  expect(socket.secure).toBe(true);

  socket.connect("ws://[::1]/foo");
  expect(socket.secure).toBe(true);

  socket.connect("wss://example.com/foo");
  expect(socket.secure).toBe(true);

  socket.socket.emit("close", { wasClean: Math.random > 0.5 });
  expect(socket.secure).toBe(false);
});

test("test certificate covers every secure WebSocket endpoint", async () => {
  const pem = await makeSelfSignedCertificate();
  const certificate = new X509Certificate(pem.cert);

  expect(certificate.checkHost("localhost")).toBe("localhost");
  expect(certificate.checkIP("127.0.0.1")).toBe("127.0.0.1");
  expect(certificate.checkIP("::1")).toBe("::1");
  expect(certificate.checkPrivateKey(createPrivateKey(pem.private))).toBe(true);
});
