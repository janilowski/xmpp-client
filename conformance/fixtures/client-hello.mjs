import assert from "node:assert/strict";

const RECORD_HEADER_BYTES = 5;
const MAX_RECORD_BYTES = 16384;
const MAX_HELLO_BYTES = 65536;
const HANDSHAKE = 22;
const CLIENT_HELLO = 1;

// Test-only reader for the initial ClientHello, not a TLS implementation.
export class ClientHello {
  #records = Buffer.alloc(0);
  #handshake = Buffer.alloc(0);

  feed(chunk) {
    this.#records = Buffer.concat([this.#records, chunk]);
    while (this.#records.length >= RECORD_HEADER_BYTES) {
      assert.equal(this.#records[0], HANDSHAKE, "Expected handshake record");
      const length = this.#records.readUInt16BE(3);
      assert.ok(
        length > 0 && length <= MAX_RECORD_BYTES,
        "Invalid record length",
      );
      if (this.#records.length < length + RECORD_HEADER_BYTES) {
        return;
      }
      this.#handshake = Buffer.concat([
        this.#handshake,
        this.#records.subarray(
          RECORD_HEADER_BYTES,
          length + RECORD_HEADER_BYTES,
        ),
      ]);
      this.#records = this.#records.subarray(length + RECORD_HEADER_BYTES);
      if (this.#handshake.length < 4) {
        continue;
      }
      assert.equal(this.#handshake[0], CLIENT_HELLO, "Expected ClientHello");
      const size = this.#handshake.readUIntBE(1, 3);
      assert.ok(size <= MAX_HELLO_BYTES, "Unbounded ClientHello");
      if (this.#handshake.length >= size + 4) {
        return parseHello(this.#handshake.subarray(4, size + 4));
      }
    }
  }
}

export function parseHello(source) {
  let offset = 0;
  const take = (size) => {
    assert.ok(offset + size <= source.length, "Truncated ClientHello field");
    const result = source.subarray(offset, offset + size);
    offset += size;
    return result;
  };
  const vector = (width) => take(take(width).readUIntBE(0, width));
  const version = take(2).toString("hex");
  take(32);
  assert.ok(vector(1).length <= 32, "Invalid session ID");
  const bytes = vector(2);
  assert.ok(
    bytes.length > 0 && bytes.length % 2 === 0,
    "Invalid cipher vector",
  );
  const ciphers = [];
  for (let index = 0; index < bytes.length; index += 2) {
    ciphers.push(bytes.subarray(index, index + 2).toString("hex"));
  }
  const compression = vector(1).toString("hex");
  const extensions = [];
  if (offset < source.length) {
    const bytes = vector(2);
    let position = 0;
    while (position < bytes.length) {
      assert.ok(position + 4 <= bytes.length, "Truncated extension header");
      const type = bytes.readUInt16BE(position);
      const size = bytes.readUInt16BE(position + 2);
      position += 4;
      assert.ok(position + size <= bytes.length, "Truncated extension body");
      extensions.push({
        type,
        value: bytes.subarray(position, position + size).toString("hex"),
      });
      position += size;
    }
  }
  assert.equal(offset, source.length, "Trailing ClientHello bytes");
  return { version, ciphers, compression, extensions };
}
