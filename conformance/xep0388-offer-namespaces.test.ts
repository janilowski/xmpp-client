import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import parseDocument from "../src/xml/lib/parseDocument.js";
import { readFrame } from "./xml.ts";

const SASL2 = "urn:xmpp:sasl:2";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND2 = "urn:xmpp:bind:0";
const SM = "urn:xmpp:sm:3";
const STREAM = "http://etherx.jabber.org/streams";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const FOREIGN = "urn:test:foreign";
const EXTENSION = "urn:test:inline-extension";

// XEP-0388 v1.0.4 §2.1: SASL2 inline is a child in the authentication namespace.
// XEP-0386 v1.1.0 §3.1: Bind2 inline contains Bind2 feature elements with var.
// Foreign lookalikes are not offers; valid extension namespaces remain extensible.
// https://xmpp.org/extensions/xep-0388.html
// https://xmpp.org/extensions/xep-0386.html
// https://www.w3.org/TR/REC-xml-names/#scoping
const cases: { name: string; offer: string; bind: boolean; sm: boolean }[] = [
  {
    name: "foreign SASL2 inline",
    offer: `<inline xmlns="${FOREIGN}"><bind xmlns="${BIND2}"/></inline>`,
    bind: false,
    sm: false,
  },
  {
    name: "cancelled SASL2 inline namespace",
    offer: `<inline xmlns=""><bind xmlns="${BIND2}"/></inline>`,
    bind: false,
    sm: false,
  },
  {
    name: "foreign Bind2 root",
    offer: `<inline><bind xmlns="${FOREIGN}"/></inline>`,
    bind: false,
    sm: false,
  },
  {
    name: "wrong local name in Bind2 namespace",
    offer: `<inline><other xmlns="${BIND2}"/></inline>`,
    bind: false,
    sm: false,
  },
  {
    name: "foreign Bind2 inline",
    offer: `<inline><bind xmlns="${BIND2}"><inline xmlns="${FOREIGN}"><feature xmlns="${BIND2}" var="${SM}"/></inline></bind></inline>`,
    bind: true,
    sm: false,
  },
  {
    name: "foreign Bind2 feature",
    offer: `<inline><bind xmlns="${BIND2}"><inline><feature xmlns="${FOREIGN}" var="${SM}"/></inline></bind></inline>`,
    bind: true,
    sm: false,
  },
  {
    name: "wrong feature local name",
    offer: `<inline><bind xmlns="${BIND2}"><inline><other var="${SM}"/></inline></bind></inline>`,
    bind: true,
    sm: false,
  },
  {
    name: "foreign inline sibling before genuine SASL2 offer",
    offer: `<inline xmlns="${FOREIGN}"/><inline><bind xmlns="${BIND2}"/></inline>`,
    bind: true,
    sm: false,
  },
  {
    name: "foreign inline sibling before genuine Bind2 offer",
    offer: `<inline><bind xmlns="${BIND2}"><inline xmlns="${FOREIGN}"/><inline><feature var="${SM}"/></inline></bind></inline>`,
    bind: true,
    sm: true,
  },
  {
    name: "prefixed genuine offer and feature",
    offer: `<s:inline xmlns:s="${SASL2}" xmlns="${FOREIGN}"><b:bind xmlns:b="${BIND2}"><b:inline><b:feature var="${SM}"/></b:inline></b:bind></s:inline>`,
    bind: true,
    sm: true,
  },
];

for (const scenario of cases) {
  test(`XEP-0388 §2.1 / XEP-0386 §3.1: ${scenario.name} has only expanded-name offer authority`, async () => {
    let authenticate: string | undefined;
    const peer = new ScriptedPeer((source, remote) => {
      const root = readFrame(source)[0];
      if (!("open" in root)) {
        throw new Error("Expected element");
      }
      if (root.open === `{${FRAMING}}open`) {
        remote.send(
          `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="offers"/>`,
        );
        remote.send(
          `<features xmlns="${STREAM}"><authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism>${scenario.offer}</authentication></features>`,
        );
      } else if (root.open === `{${SASL2}}authenticate`) {
        authenticate = source;
        // Settle every case deterministically after observing the actual request.
        remote.send(
          `<failure xmlns="${SASL2}"><not-authorized xmlns="${SASL}"/></failure>`,
        );
      } else if (root.open === `{${FRAMING}}close`) {
        remote.send(`<close xmlns="${FRAMING}"/>`);
      }
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    try {
      const failed = await xmpp.start().catch((error: Error) => error);
      expect(failed).toMatchObject({
        name: "SASLError",
        condition: "not-authorized",
      });
      expect(authenticate).toBeString();
      const request = parseDocument(authenticate!)!;
      expect(request.getChildren("bind", BIND2)).toHaveLength(
        scenario.bind ? 1 : 0,
      );
      const enables =
        request.getChild("bind", BIND2)?.getChildren("enable", SM) ?? [];
      expect(enables).toHaveLength(scenario.sm ? 1 : 0);
      if (enables.length) {
        expect(enables[0].attrs).toEqual({ xmlns: SM, resume: "true" });
      }
      expect(errors).toEqual([failed]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  });
}

test("XEP-0388 §2.1: a genuine prefixed inline container retains independently defined extensions", async () => {
  const calls: Array<string | undefined> = [];
  let authenticate: string | undefined;
  const peer = new ScriptedPeer((source, remote) => {
    if (source.startsWith("<open")) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}"><authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism><s:inline xmlns:s="${SASL2}"><x:extension xmlns:x="${EXTENSION}"/></s:inline></authentication></features>`,
      );
    } else if (source.startsWith("<authenticate")) {
      authenticate = source;
      remote.send(
        `<failure xmlns="${SASL2}"><not-authorized xmlns="${SASL}"/></failure>`,
      );
    } else if (source.startsWith("<close")) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.sasl2.use(
    EXTENSION,
    (element: Element) => {
      if (element.is("extension", EXTENSION)) {
        calls.push(element.getNS());
        return xml("request", { xmlns: EXTENSION });
      }
    },
    () => {},
  );
  try {
    const failed = await xmpp.start().catch((error: Error) => error);
    expect(failed).toMatchObject({
      name: "SASLError",
      condition: "not-authorized",
    });
    expect(calls).toEqual([EXTENSION]);
    expect(errors).toEqual([failed]);
    expect(
      parseDocument(authenticate!)!.getChild("request", EXTENSION)?.toString(),
    ).toBe(`<request xmlns="${EXTENSION}"/>`);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test("XEP-0388 / XEP-0386: foreign offer cannot poison fresh Bind2 and SM negotiation", async () => {
  let firstRequest: string | undefined;
  const first = new ScriptedPeer((source, remote) => {
    if (source.startsWith("<open")) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}"><authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism><inline xmlns="${FOREIGN}"><bind xmlns="${BIND2}"/></inline></authentication></features>`,
      );
    } else if (source.startsWith("<authenticate")) {
      firstRequest = source;
      remote.send(
        `<failure xmlns="${SASL2}"><not-authorized xmlns="${SASL}"/></failure>`,
      );
    } else if (source.startsWith("<close")) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  let secondRequest: string | undefined;
  const recoveryFrames: string[] = [];
  const second = new ScriptedPeer((source, remote) => {
    recoveryFrames.push(source);
    if (source.startsWith("<open")) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}"><authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism><s:inline xmlns:s="${SASL2}"><b:bind xmlns:b="${BIND2}"><b:inline><b:feature var="${SM}"/></b:inline></b:bind></s:inline></authentication></features>`,
      );
    } else if (source.startsWith("<authenticate")) {
      secondRequest = source;
      remote.send(
        `<s:success xmlns:s="${SASL2}"><s:authorization-identifier>user@example.test/recovered</s:authorization-identifier><b:bound xmlns:b="${BIND2}"><m:enabled xmlns:m="${SM}" id="recovered-sm" resume="true"/></b:bound></s:success>`,
      );
      remote.send(`<features xmlns="${STREAM}"/>`);
    } else if (source.startsWith("<close")) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  const xmpp = client({
    service: first.url,
    domain: "example.test",
    username: "user",
    password: "secret",
  });
  xmpp.reconnect.stop();
  xmpp.streamManagement.requestAckInterval = 0;
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    const failed = await xmpp.start().catch((error: Error) => error);
    expect(failed).toMatchObject({
      name: "SASLError",
      condition: "not-authorized",
    });
    expect(
      parseDocument(firstRequest!)!.getChild("bind", BIND2),
    ).toBeUndefined();
    await xmpp.stop();
    expect(errors).toEqual([failed]);
    errors.length = 0;
    Object.assign(xmpp.options, { service: second.url });
    expect((await xmpp.start()).toString()).toBe("user@example.test/recovered");
    const bind = parseDocument(secondRequest!)!.getChild("bind", BIND2)!;
    expect(bind.toString()).toBe(
      `<bind xmlns="${BIND2}"><enable xmlns="${SM}" resume="true"/></bind>`,
    );
    expect(xmpp.streamManagement.enabled).toBe(true);
    expect(xmpp.streamManagement.id).toBe("recovered-sm");
    await xmpp.send(
      xml("message", { id: "recovered" }, xml("body", {}, "usable")),
    );
    // Explicit peer frames observe the fresh exchange and subsequent application write.
    const frames = [];
    for (let index = 0; index < 3; index += 1) {
      frames.push(await second.next());
    }
    expect(frames[1]).toBe(secondRequest!);
    expect(frames[2]).toBe(
      '<message id="recovered" xmlns="jabber:client"><body>usable</body></message>',
    );
    expect(recoveryFrames).toEqual(frames);
    expect(errors).toEqual([]);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await first.stop();
    await second.stop();
  }
});
