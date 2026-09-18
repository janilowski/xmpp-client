export function encode(value) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;

  if (typeof bytes.toBase64 === "function") {
    return bytes.toBase64();
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return globalThis.btoa(binary);
}

export function decode(data) {
  return new TextDecoder().decode(decodeBytes(data));
}

export function decodeBytes(data) {
  let bytes;
  if (typeof Uint8Array.fromBase64 === "function") {
    bytes = Uint8Array.fromBase64(data);
  } else {
    const binary = globalThis.atob(data);
    bytes = Uint8Array.from(binary, (character) =>
      character.codePointAt(0),
    );
  }

  // RFC 6120 §13.9.1: runtime decoders can ignore whitespace, padding or pad bits.
  if (encode(bytes) !== data) {
    throw new TypeError("Invalid Base64 encoding");
  }
  return bytes;
}
