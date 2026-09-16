import { SaxesParser } from "saxes";

const NS_XMLNS = "http://www.w3.org/2000/xmlns/";

/** Independent XML oracle: compare expanded names, not serializer formatting. */
export function readFrame(source: string) {
  if (!source.startsWith("<")) {
    throw new Error("RFC 7395 frame must start with <");
  }
  const events: (
    | { open: string; attributes: Record<string, string> }
    | { text: string }
    | { close: string }
  )[] = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) =>
    events.push({
      open: `{${tag.uri}}${tag.local}`,
      attributes: Object.fromEntries(
        Object.values(tag.attributes)
          .filter((attribute) => attribute.uri !== NS_XMLNS)
          .map((attribute) => [
            `{${attribute.uri}}${attribute.local}`,
            attribute.value,
          ]),
      ),
    }),
  );
  parser.on("text", (text) => events.push({ text }));
  parser.on("closetag", (tag) =>
    events.push({ close: `{${tag.uri}}${tag.local}` }),
  );
  parser.write(source).close();
  return events;
}
