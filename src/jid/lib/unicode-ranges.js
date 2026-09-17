// Internal generated-data format: five payload bits and one continuation bit.
export const RANGE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const PAYLOAD_BITS = 5;
const CONTINUATION = 1 << PAYLOAD_BITS;
const PAYLOAD_MASK = CONTINUATION - 1;
const UNICODE_END = 0x110000;
const MAX_SHIFT = 20; // Unicode run lengths need at most 21 bits.

export function decodeRanges(data) {
  const parts = [];
  let point = 0;
  let value = 0;
  let shift = 0;
  let start;

  // Each pair is a gap from the previous exclusive end, then a range length.
  for (const char of data) {
    const digit = RANGE_ALPHABET.indexOf(char);
    if (digit < 0 || shift > MAX_SHIFT) {
      throw new Error("Invalid Unicode table encoding.");
    }
    value |= (digit & PAYLOAD_MASK) << shift;
    if (digit & CONTINUATION) {
      shift += PAYLOAD_BITS;
      continue;
    }
    point += value;
    if (point > UNICODE_END) {
      throw new Error("Unicode range exceeds U+10FFFF.");
    }
    if (start === undefined) {
      start = point;
    } else {
      if (!value) {
        throw new Error("Empty Unicode range.");
      }
      const end = point - 1;
      parts.push(
        `\\u{${start.toString(16)}}` +
          (start === end ? "" : `-\\u{${end.toString(16)}}`),
      );
      start = undefined;
    }
    value = shift = 0;
  }
  if (shift || start !== undefined) {
    throw new Error("Incomplete Unicode range.");
  }

  // Preserve native RegExp matching; decoding adds no work to JID validation.
  return new RegExp(`[${parts.join("")}]`, "u");
}
