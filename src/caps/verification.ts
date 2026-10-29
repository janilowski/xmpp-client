import type { Element } from "../../types/index.js";
import { encode } from "../util/base64.js";

const INFO = "http://jabber.org/protocol/disco#info";
const DATA = "jabber:x:data";
const FORM_TYPE = "FORM_TYPE";
const HASH_ALGORITHMS = { "sha-1": "SHA-1", "sha-256": "SHA-256" } as const;
const encoder = new TextEncoder();

// Valid data forms can contain anonymous fixed fields, with no defined caps hash.
export class UnverifiableFormError extends TypeError {
  constructor() {
    super("Cannot verify a capability field without var");
    this.name = "UnverifiableFormError";
  }
}

// XEP-0115 §5.1 uses UTF-8 octets, not JavaScript's UTF-16 or locale sorting.
function compare(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return a.length - b.length;
}

function fieldValues(field: Element): string[] {
  return field.getChildren("value", DATA).map((value) => {
    if (value.getChildElements().length !== 0) {
      throw new TypeError("Capability form values must contain only text");
    }
    return value.getText();
  });
}

// Work on raw disco XML: inferred features or deduplication would change the hash.
export function canonicalize(query: Element): string {
  if (!query.is("query", INFO)) {
    throw new TypeError("Expected a discovery information query");
  }
  const seenIdentities = new Set<string>();
  const identities = query.getChildren("identity", INFO).map((identity) => {
    const { category, type, name = "", "xml:lang": lang = "" } = identity.attrs;
    const key = JSON.stringify([category, type, lang]);
    if (!category || !type || seenIdentities.has(key)) {
      throw new TypeError("Invalid or duplicate capability identity");
    }
    seenIdentities.add(key);
    return [category, type, lang, name];
  });
  if (identities.length === 0) {
    throw new TypeError("Capability information needs an identity");
  }
  identities.sort(
    (a, b) => compare(a[0], b[0]) || compare(a[1], b[1]) || compare(a[2], b[2]),
  );
  const parts = identities.map((identity) => `${identity.join("/")}<`);

  const seenFeatures = new Set<string>();
  for (const feature of query.getChildren("feature", INFO)) {
    const value = feature.attrs.var;
    if (!value || feature.children.length !== 0 || seenFeatures.has(value)) {
      throw new TypeError("Invalid or duplicate capability feature");
    }
    seenFeatures.add(value);
  }
  for (const feature of [...seenFeatures].sort(compare)) {
    parts.push(`${feature}<`);
  }

  const forms = new Map<string, Map<string, string[]>>();
  let unverifiable = false;
  for (const form of query.getChildren("x", DATA)) {
    const fields = form.getChildren("field", DATA);
    const types = fields.filter((field) => field.attrs.var === FORM_TYPE);
    // XEP-0115 §5.4: ignored forms cannot invalidate the remaining response.
    if (
      types.length === 0 ||
      types.every((field) => field.attrs.type !== "hidden")
    ) {
      continue;
    }
    if (types.length !== 1) {
      throw new TypeError("Duplicate FORM_TYPE fields");
    }
    const values = fieldValues(types[0]);
    const type = values[0];
    if (
      type === undefined ||
      values.some((value) => value !== type) ||
      forms.has(type)
    ) {
      throw new TypeError("Invalid or duplicate capability form type");
    }
    const data = new Map<string, string[]>();
    for (const field of fields) {
      const variable = field.attrs.var;
      if (variable === FORM_TYPE) {
        continue;
      }
      // XEP-0004 permits anonymous fixed fields; XEP-0115 defines no hash for them.
      // Keep such discovery data usable, but do not invent a verification string.
      if (variable === undefined) {
        if (field.attrs.type !== "fixed") {
          throw new TypeError("Capability form fields require var");
        }
        fieldValues(field);
        unverifiable = true;
        continue;
      }
      if (data.has(variable)) {
        throw new TypeError("Duplicate capability form field");
      }
      data.set(variable, fieldValues(field));
    }
    forms.set(type, data);
  }
  // A valid unhashable field must not hide malformed fields or later forms.
  if (unverifiable) {
    throw new UnverifiableFormError();
  }
  for (const type of [...forms.keys()].sort(compare)) {
    parts.push(`${type}<`);
    const fields = forms.get(type)!;
    for (const variable of [...fields.keys()].sort(compare)) {
      parts.push(`${variable}<`);
      for (const value of fields.get(variable)!.sort(compare)) {
        parts.push(`${value}<`);
      }
    }
  }
  return parts.join("");
}

export async function verificationString(
  query: Element,
  algorithm: keyof typeof HASH_ALGORITHMS = "sha-1",
): Promise<string> {
  if (!Object.hasOwn(HASH_ALGORITHMS, algorithm)) {
    throw new TypeError("Unsupported capability hash algorithm");
  }
  // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Browser Web Crypto is part of this client profile.
  const digest = await globalThis.crypto.subtle.digest(
    HASH_ALGORITHMS[algorithm],
    encoder.encode(canonicalize(query)),
  );
  return encode(new Uint8Array(digest));
}
