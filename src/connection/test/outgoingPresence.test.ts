import { expect, test } from "bun:test";
import type { Element } from "../../../types/index.js";
import { EventEmitter } from "../../events/index.js";
import { ConnectionClosedError } from "../../events/lib/operation.js";
import xml from "../../xml/index.js";
import parseXML from "../../xml/lib/parseDocument.js";
import Connection from "../index.js";
import { outgoingPresence } from "../lib/outgoingPresence.ts";
import { sendPolicies, sendReplay } from "../lib/sendPolicy.js";

const CLIENT = "jabber:client";
const SERVER = "jabber:server";
const CAPS = "http://jabber.org/protocol/caps";
const parseDocument = parseXML as unknown as (source: string) => Element;

// Driver unit tests: protocol exchanges and caps verification have their own suites.
function connection() {
  const entity = new Connection();
  const writes: string[] = [];
  Object.assign(entity, { NS: CLIENT });
  entity.root = xml("stream", { xmlns: CLIENT });
  entity.socket = {
    write(source: string, callback: () => void) {
      writes.push(source);
      callback();
    },
  };
  return { entity, writes };
}

test("presence preparation follows original validation and precedes admission/write/send", async () => {
  const { entity, writes } = connection();
  const order: string[] = [];
  const received: string[] = [];
  const sent: Element[] = [];
  const original = xml(
    "presence",
    { xmlns: CLIENT, id: "p" },
    xml("status", {}, "Here"),
  );
  const serialize = original.toString.bind(original);
  let serializations = 0;
  original.toString = () => {
    serializations++;
    return serialize();
  };
  let prepared: Element | undefined;
  outgoingPresence.set(entity, async (source) => {
    order.push("prepare");
    received.push(source);
    prepared = parseDocument(source);
    prepared.c("c", {
      xmlns: CAPS,
      node: "urn:test:client",
      hash: "sha-1",
      ver: "value",
    });
    return prepared;
  });
  sendPolicies.set(entity, {
    prepare({ element, source }: { element: Element; source: string }) {
      order.push("admit");
      expect(element).toBe(prepared!);
      expect(source).toBe(prepared!.toString());
    },
  });
  const driverWrite = entity.socket.write;
  entity.socket.write = (source: string, callback: () => void) => {
    order.push("write");
    driverWrite(source, callback);
  };
  entity.on("send", (element: Element) => {
    order.push("send");
    sent.push(element);
  });

  await entity.send(original);

  expect(order).toEqual(["prepare", "admit", "write", "send"]);
  expect(serializations).toBe(1);
  expect(received).toEqual([
    `<presence xmlns="${CLIENT}" id="p"><status>Here</status></presence>`,
  ]);
  expect(writes).toEqual([
    `<presence xmlns="${CLIENT}" id="p"><status>Here</status><c xmlns="${CAPS}" node="urn:test:client" hash="sha-1" ver="value"/></presence>`,
  ]);
  expect(sent).toEqual([prepared!]);
  expect(original.getChild("c", CAPS)).toBeUndefined();
});

test("invalid original XML never invokes the presence preparer or admission", async () => {
  const { entity, writes } = connection();
  let effects = 0;
  outgoingPresence.set(entity, async (source) => {
    effects++;
    return parseDocument(source);
  });
  sendPolicies.set(entity, {
    prepare() {
      effects++;
    },
  });
  const original = xml("presence", { xmlns: CLIENT });
  original.toString = () => `<presence xmlns="${CLIENT}">`;
  await expect(entity.send(original)).rejects.toThrow("Invalid outgoing XML");
  expect(effects).toBe(0);
  expect(writes).toEqual([]);
});

test.each([
  ["root", () => xml("message", { xmlns: CLIENT, id: "p" })],
  ["namespace", () => xml("presence", { xmlns: "urn:foreign", id: "p" })],
  ["envelope", () => xml("presence", { xmlns: CLIENT, id: "changed" })],
  [
    "destination",
    () =>
      xml("presence", { xmlns: CLIENT, id: "p", to: "other@remote.test/r" }),
  ],
  [
    "sender",
    () =>
      xml("presence", { xmlns: CLIENT, id: "p", from: "other@example.test/r" }),
  ],
  [
    "language",
    () => xml("presence", { xmlns: CLIENT, id: "p", "xml:lang": "en_US" }),
  ],
  [
    "core error",
    () => xml("presence", { xmlns: CLIENT, id: "p" }, xml("error")),
  ],
  [
    "XML",
    () => {
      const prepared = xml("presence", { xmlns: CLIENT, id: "p" });
      prepared.toString = () => `<presence xmlns="${CLIENT}" id="p">`;
      return prepared;
    },
  ],
] as const)(
  "prepared presence must retain a validated %s",
  async (_name, prepare) => {
    const { entity, writes } = connection();
    let admissions = 0;
    const sent: Element[] = [];
    outgoingPresence.set(entity, async () => prepare());
    sendPolicies.set(entity, {
      prepare() {
        admissions++;
      },
    });
    entity.on("send", (element: Element) => sent.push(element));
    await expect(
      entity.send(xml("presence", { xmlns: CLIENT, id: "p" })),
    ).rejects.toThrow("Invalid outgoing XML");
    expect(admissions).toBe(0);
    expect(writes).toEqual([]);
    expect(sent).toEqual([]);
  },
);

test("presence preparation rejection has no admission or wire effects", async () => {
  const { entity, writes } = connection();
  const failure = new Error("Preparation failed");
  let admissions = 0;
  outgoingPresence.set(entity, async () => {
    throw failure;
  });
  sendPolicies.set(entity, {
    prepare() {
      admissions++;
    },
  });
  await expect(entity.send(xml("presence", { xmlns: CLIENT }))).rejects.toBe(
    failure,
  );
  expect(admissions).toBe(0);
  expect(writes).toEqual([]);
});

test.each(["socket", "parser"] as const)(
  "pending presence preparation cannot write through a replacement %s",
  async (replacement) => {
    const { entity, writes } = connection();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let admissions = 0;
    outgoingPresence.set(entity, async (source) => {
      entered.resolve();
      await release.promise;
      return parseDocument(source);
    });
    sendPolicies.set(entity, {
      prepare() {
        admissions++;
      },
    });
    const sending = entity
      .send(xml("presence", { xmlns: CLIENT }))
      .catch((error: Error) => error);
    expect(
      await Promise.race([
        entered.promise.then(() => "entered"),
        sending.then(() => "completed"),
      ]),
    ).toBe("entered");
    if (replacement === "socket") {
      entity.socket = {
        write(source: string, callback: () => void) {
          writes.push(source);
          callback();
        },
      };
    } else {
      entity._attachParser(new EventEmitter());
    }
    release.resolve();
    expect(await sending).toBeInstanceOf(ConnectionClosedError);
    expect(admissions).toBe(0);
    expect(writes).toEqual([]);
  },
);

test("pending preparation uses the validated snapshot, not later caller mutation", async () => {
  const { entity, writes } = connection();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = xml("presence", { xmlns: CLIENT, id: "original" });
  const serialize = original.toString.bind(original);
  let serializations = 0;
  original.toString = () => {
    serializations++;
    return serialize();
  };
  outgoingPresence.set(entity, async (source) => {
    entered.resolve();
    await release.promise;
    return parseDocument(source);
  });
  const sending = entity.send(original);
  expect(
    await Promise.race([
      entered.promise.then(() => "entered"),
      sending.then(() => "completed"),
    ]),
  ).toBe("entered");
  original.attrs.id = "changed";
  original.toString = () => {
    throw new Error("Must not serialize twice");
  };
  release.resolve();
  await sending;
  expect(serializations).toBe(1);
  expect(writes).toEqual([`<presence xmlns="${CLIENT}" id="original"/>`]);
});

test("closure during preparation cannot write or retain an admission", async () => {
  const { entity, writes } = connection();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let admissions = 0;
  let rollbacks = 0;
  const sent: Element[] = [];
  outgoingPresence.set(entity, async (source) => {
    entered.resolve();
    await release.promise;
    return parseDocument(source);
  });
  sendPolicies.set(entity, {
    prepare() {
      admissions++;
      return {
        rollback() {
          rollbacks++;
        },
      };
    },
  });
  entity.on("send", (element: Element) => sent.push(element));
  const sending = entity
    .send(xml("presence", { xmlns: CLIENT }))
    .catch((error: Error) => error);
  expect(
    await Promise.race([
      entered.promise.then(() => "entered"),
      sending.then(() => "completed"),
    ]),
  ).toBe("entered");
  entity.status = "closing";
  release.resolve();
  expect((await sending)?.message).toBe("Connection is closing");
  expect(rollbacks).toBe(admissions);
  expect(writes).toEqual([]);
  expect(sent).toEqual([]);
});

test("SM replay bypasses presence preparation without losing admission identity", async () => {
  const { entity, writes } = connection();
  let preparations = 0;
  const item = {};
  const replays: unknown[] = [];
  outgoingPresence.set(entity, async (source) => {
    preparations++;
    return parseDocument(source);
  });
  sendPolicies.set(entity, {
    prepare({ replay }: { replay: unknown }) {
      replays.push(replay);
    },
  });
  await sendReplay(
    entity,
    item,
    xml("presence", { xmlns: CLIENT, id: "replay" }),
  );
  expect(preparations).toBe(0);
  expect(replays).toEqual([item]);
  expect(writes).toEqual([`<presence xmlns="${CLIENT}" id="replay"/>`]);
});

test.each([
  xml("message", { xmlns: CLIENT }),
  xml("iq", { xmlns: CLIENT, type: "result", id: "iq" }),
  xml("presence", { xmlns: "urn:foreign" }),
])("non-client-presence elements bypass preparation", async (element) => {
  const { entity, writes } = connection();
  let preparations = 0;
  outgoingPresence.set(entity, async (source) => {
    preparations++;
    return parseDocument(source);
  });
  await entity.send(element);
  expect(preparations).toBe(0);
  expect(writes).toEqual([element.toString()]);
});

test("server-stream presence bypasses client presence preparation", async () => {
  const { entity, writes } = connection();
  Object.assign(entity, { NS: SERVER });
  entity.root = xml("stream", { xmlns: SERVER });
  let preparations = 0;
  outgoingPresence.set(entity, async (source) => {
    preparations++;
    return parseDocument(source);
  });
  await entity.send(xml("presence", { xmlns: SERVER }));
  expect(preparations).toBe(0);
  expect(writes).toEqual([`<presence xmlns="${SERVER}"/>`]);
});
