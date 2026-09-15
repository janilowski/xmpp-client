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
  if (typeof Uint8Array.fromBase64 === "function") {
    return Uint8Array.fromBase64(data);
  }

  const binary = globalThis.atob(data);
  return Uint8Array.from(binary, (character) =>
    character.codePointAt(0),
  );
}
