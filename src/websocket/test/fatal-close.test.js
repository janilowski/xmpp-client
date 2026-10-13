import { expect, test } from "bun:test";
import Parser from "../lib/FramedParser.js";
import XMLError from "../../xml/lib/XMLError.js";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const CLIENT = "jabber:client";
const STREAM = "http://etherx.jabber.org/streams";
const OPEN = `<open xmlns="${FRAMING}" version="1.0"/>`;
const CLOSE = `<close xmlns="${FRAMING}"/>`;
const MESSAGE = `<message xmlns="${CLIENT}"/>`;

// RFC 6120 §§4.4/4.9.1.1 and RFC 7395 §§3.3.3/3.6: a fatal document
// never resumes, but the same parser must recognize the reciprocal close.
for (const [failure, stage, frame] of [
  ["element before open", "opening", MESSAGE],
  ["truncated opening", "opening", `<open xmlns="${FRAMING}" version="1.0">`],
  [
    "wrong opening namespace",
    "opening",
    '<open xmlns="urn:wrong" version="1.0"/>',
  ],
  [
    "unsupported opening version",
    "opening",
    `<open xmlns="${FRAMING}" version="2.0"/>`,
  ],
  ["truncated stanza", "open", `<message xmlns="${CLIENT}">`],
  [
    "multiple document roots",
    "open",
    `${MESSAGE}<presence xmlns="${CLIENT}"/>`,
  ],
  ["restricted XML", "open", `<!DOCTYPE message>${MESSAGE}`],
  [
    "nonempty closing header",
    "open",
    `<close xmlns="${FRAMING}"><child/></close>`,
  ],
  ["second opening", "open", OPEN],
]) {
  test.each([
    ["default namespace", CLOSE],
    ["prefix alias", `<f:close xmlns:f="${FRAMING}" xmlns="urn:other"/>`],
    ["explicit ending tag", `<close xmlns="${FRAMING}"></close>`],
    [
      "permitted XML declaration",
      `<?xml version="1.0" encoding="UTF-8"?>${CLOSE}`,
    ],
    // RFC 6120 §11.5: the receive profile ignores SDDecl, unlike outbound XML.
    [
      "ignored standalone yes",
      `<?xml version="1.0" standalone="yes"?>${CLOSE}`,
    ],
    ["ignored standalone no", `<?xml version="1.0" standalone="no"?>${CLOSE}`],
  ])(
    `fatal ${failure} accepts one reciprocal close without revival / %s`,
    (_alternative, close) => {
      const parser = new Parser();
      const opened = [];
      const elements = [];
      const closed = [];
      const errors = [];
      parser.on("start", (element) => opened.push(element));
      parser.on("element", (element) => elements.push(element));
      parser.on("end", (element) => closed.push(element));
      parser.on("error", (error) => errors.push(error));
      if (stage === "open") {
        parser.write(OPEN);
      }

      parser.write(frame);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(XMLError);
      const failure = errors[0];
      const opening = [...opened];
      expect(opened).toHaveLength(stage === "open" ? 1 : 0);
      expect(elements).toEqual([]);
      expect(closed).toEqual([]);

      // Neither another document nor the old document's continuation can revive it.
      for (const subsequent of [
        OPEN,
        MESSAGE,
        `<features xmlns="${STREAM}"/>`,
        "</message>",
      ]) {
        parser.write(subsequent);
      }
      expect(errors).toEqual([failure]);
      expect(opened).toEqual(opening);
      expect(elements).toEqual([]);
      expect(closed).toEqual([]);

      parser.write(close);
      expect(closed).toHaveLength(1);
      expect(closed[0].getName()).toBe("close");
      expect(closed[0].getNS()).toBe(FRAMING);
      expect(closed[0].children).toEqual([]);
      const closing = closed[0];
      for (const subsequent of [CLOSE, OPEN, MESSAGE, "<message>"]) {
        parser.end(subsequent);
      }
      expect(closed).toEqual([closing]);
      expect(errors).toEqual([failure]);
      expect(opened).toEqual(opening);
      expect(elements).toEqual([]);
    },
  );
}

test.each([
  ["wrong namespace", '<close xmlns="urn:wrong"/>'],
  ["absent namespace", "<close/>"],
  ["unbound prefix", "<f:close/>"],
  ["child element", `<close xmlns="${FRAMING}"><child/></close>`],
  ["text content", `<close xmlns="${FRAMING}">text</close>`],
  ["whitespace content", `<close xmlns="${FRAMING}"> </close>`],
  ["truncated document", `<close xmlns="${FRAMING}">`],
  ["trailing text", `${CLOSE}garbage`],
  ["multiple roots", `${CLOSE}${MESSAGE}`],
  ["duplicate attribute", `<close xmlns="${FRAMING}" id="one" id="two"/>`],
  ["restricted declaration", `<!DOCTYPE close>${CLOSE}`],
  ["comment", `${CLOSE}<!--comment-->`],
  ["processing instruction", `<?app instruction?>${CLOSE}`],
  ["unsupported XML version", `<?xml version="1.1"?>${CLOSE}`],
  ["leading whitespace", ` ${CLOSE}`],
  ["empty frame", ""],
  ["non-string frame", { toString: () => CLOSE }],
])(
  "fatal parser ignores an invalid reciprocal close without another error / %s",
  (_invalid, frame) => {
    const parser = new Parser();
    const opened = [];
    const elements = [];
    const closed = [];
    const errors = [];
    parser.on("start", (element) => opened.push(element));
    parser.on("element", (element) => elements.push(element));
    parser.on("end", (element) => closed.push(element));
    parser.on("error", (error) => errors.push(error));
    parser.write(OPEN);
    parser.write(`<message xmlns="${CLIENT}">`);
    expect(errors).toHaveLength(1);
    const failure = errors[0];
    const opening = opened[0];

    parser.write(frame);
    expect(closed).toEqual([]);
    expect(errors).toEqual([failure]);
    expect(opened).toEqual([opening]);
    expect(elements).toEqual([]);

    parser.end(CLOSE);
    expect(closed).toHaveLength(1);
    expect(closed[0].getName()).toBe("close");
    expect(closed[0].getNS()).toBe(FRAMING);
    expect(errors).toEqual([failure]);
    expect(opened).toEqual([opening]);
    expect(elements).toEqual([]);
  },
);

test("fatal parser accepts a synchronous reciprocal close from its error observer", () => {
  const parser = new Parser();
  const closed = [];
  const errors = [];
  parser.on("end", (element) => closed.push(element));
  parser.on("error", (error) => {
    errors.push(error);
    parser.write(CLOSE);
  });
  parser.write(OPEN);
  parser.write(`<message xmlns="${CLIENT}">`);

  expect(errors).toHaveLength(1);
  expect(closed).toHaveLength(1);
  expect(closed[0].getName()).toBe("close");
  expect(closed[0].getNS()).toBe(FRAMING);
  parser.write(CLOSE);
  expect(closed).toHaveLength(1);
  expect(errors).toHaveLength(1);
});
