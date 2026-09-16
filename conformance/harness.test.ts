import { expect, test } from "bun:test";
import { readFrame } from "./xml.ts";
import { ScriptedPeer } from "./peer.ts";

test("peer silence rejects instead of becoming a successful test", async () => {
  const peer = new ScriptedPeer(() => {});
  try {
    await expect(peer.next()).rejects.toThrow("Missing peer frame");
  } finally {
    await peer.stop();
  }
});

test("peer teardown rejects an outstanding frame reader", async () => {
  const peer = new ScriptedPeer(() => {});
  const result = peer.next().catch((error: Error) => error);
  await peer.stop();
  expect(await result).toEqual(new Error("Peer stopped"));
});

test("XML oracle ignores prefix spelling and attribute order", () => {
  expect(readFrame('<a:x xmlns:a="urn:test" b="2" a="1"/>')).toEqual(
    readFrame('<x a="1" b="2" xmlns="urn:test"></x>'),
  );
});

test.each([
  '<message xmlns="jabber:client">',
  "<message/><presence/>",
  "<stream:features/>",
  "<message/>garbage",
  '<message id="a" id="b"/>',
  " <message/>",
])("XML oracle rejects invalid standalone frame: %s", (frame) => {
  expect(() => readFrame(frame)).toThrow();
});

test("XML oracle accepts numeric character references", () => {
  expect(readFrame("<body>&#65;&#x1F426;</body>")).toEqual(
    readFrame("<body>A🐦</body>"),
  );
});
