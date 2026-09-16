import Parser from "../lib/Parser.js";
import parse from "../lib/parse.js";

test("stream parser", (done) => {
  const parser = new Parser();

  expect.assertions(5);

  let startElement;

  parser.on("start", (el) => {
    expect(el.toString()).toBe("<foo/>");
    startElement = el;
  });

  parser.on("element", (el) => {
    expect(el.parent).toBe(startElement);
    expect(startElement.children).toHaveLength(0);
    expect(el.toString()).toBe("<bar>hello</bar>");
  });

  parser.on("end", (el) => {
    expect(el.toString()).toBe("<foo/>");
    done();
  });

  parser.write("<foo><bar>hello</bar></foo>");
});

test("stream parser preserves events, namespaces and nesting across chunks", () => {
  const parser = new Parser();
  const events = [];
  parser.on("start", (root) => events.push(["start", root.name]));
  parser.on("element", (element) => {
    expect(element.getNS()).toBe("jabber:client");
    expect(element.parent).toBe(parser.root);
    expect(parser.root.children).toEqual([]);
    events.push(["element", element.getChildText("body")]);
  });
  parser.on("end", (root) => events.push(["end", root.name]));
  for (const chunk of [
    '<stream:stream xmlns:stream="http://etherx.jabber.org/streams" xmlns="jabber:client">',
    "<message><body>A &am",
    "p; B</body></message><message><body>second</body></message>",
    "</stream:stream>",
  ]) {
    parser.write(chunk);
  }
  parser.end();
  expect(events).toEqual([
    ["start", "stream:stream"],
    ["element", "A & B"],
    ["element", "second"],
    ["end", "stream:stream"],
  ]);
});

test("stream parser retains CDATA and numeric references", () => {
  const parser = new Parser();
  const elements = [];
  parser.on("element", (element) => elements.push(element));
  parser.end("<root><body><![CDATA[<text>]]>&#65;&#x1F426;</body></root>");
  expect(elements[0].getText()).toBe("<text>A🐦");
});

test.each([
  "<root><child>",
  '<root><child a="1" a="2"/></root>',
  "<root><unbound:child/></root>",
  "<root><child></wrong></root>",
])("stream parser reports one XML error and stops: %s", (source) => {
  const parser = new Parser();
  const errors = [];
  const elements = [];
  let deliveredAtError;
  parser.on("error", (error) => {
    deliveredAtError = elements.length;
    errors.push(error);
  });
  parser.on("element", (element) => elements.push(element));
  parser.end(source);
  parser.write("<child/>");
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(Parser.XMLError);
  // Streaming may deliver earlier events; only document parsing is atomic.
  expect(elements).toHaveLength(deliveredAtError);
});

test("document parsing retains the complete element tree", () => {
  const root = parse(
    '<root xmlns="urn:test"><child><nested>text</nested></child></root>',
  );
  expect(root.getChild("child").getChildText("nested")).toBe("text");
  expect(root.getChild("child").getNS()).toBe("urn:test");
});

test.each(["<root><child/>", "<root/><another/>"])(
  "document parsing rejects incomplete or multiple documents: %s",
  (source) => {
    expect(() => parse(source)).toThrow();
  },
);
