import { client, xml } from "./index.js";
import debug from "../debug/index.js";

// Insecure!
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const xmpp = client({
  service: "ws://localhost:5280/xmpp-websocket",
  // service: "xmpps://localhost:5223",
  // service: "xmpp://localhost:5222",
  domain: "localhost",
  resource: "example",
  username: "username",
  password: "password",
});

debug(xmpp, true);

xmpp.on("error", (err) => {
  console.error(err);
});

xmpp.on("offline", () => {
  console.log("offline");
});

xmpp.on("stanza", onStanza);
async function onStanza(stanza) {
  if (stanza.is("message")) {
    xmpp.removeListener("stanza", onStanza);
    await xmpp.send(
      xml("presence", {
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Browser Web Crypto is part of this client profile.
        id: globalThis.crypto.randomUUID(),
        type: "unavailable",
      }),
    );
    await xmpp.stop();
  }
}

xmpp.on("online", async (address) => {
  console.log("online as", address.toString());

  // Makes itself available
  // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Browser Web Crypto is part of this client profile.
  await xmpp.send(xml("presence", { id: globalThis.crypto.randomUUID() }));

  // Sends a chat message to itself
  const message = xml(
    "message",
    {
      // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Browser Web Crypto is part of this client profile.
      id: globalThis.crypto.randomUUID(),
      type: "chat",
      to: address,
    },
    xml("body", {}, "hello world"),
  );
  await xmpp.send(message);
});

await xmpp.start();
