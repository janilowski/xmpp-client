import XMPPError from "../../error/index.js";

import SASLError from "./SASLError.js";
import parseDocument from "../../xml/lib/parseDocument.js";

const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";

// Namespaces §6.1 / RFC 6120 §6.5: prefixes are not condition names.
for (const namespace of [SASL, "urn:xmpp:sasl:2"]) {
  for (const condition of [
    "aborted",
    "account-disabled",
    "credentials-expired",
    "future-condition",
  ]) {
    test(`SASL expanded condition ${condition} / ${namespace}`, () => {
      const source = `<f:failure xmlns:f="${namespace}"><t:text xmlns:t="${namespace}">diagnostic</t:text><c:${condition} xmlns:c="${SASL}"/></f:failure>`;
      const error = SASLError.fromElement(parseDocument(source));
      expect(error.condition).toBe(
        condition === "future-condition" ? "not-authorized" : condition,
      );
      expect(error.text).toBe("diagnostic");
    });
  }
}

// https://xmpp.org/rfcs/rfc6120.html#rfc.section.6.4.5
// https://xmpp.org/rfcs/rfc6120.html#rfc.section.A.4

test("SASL", () => {
  const nonza = (
    <failure xmlns="urn:ietf:params:xml:ns:xmpp-sasl">
      <not-authorized />
    </failure>
  );

  const error = SASLError.fromElement(nonza);

  expect(error instanceof Error).toBe(true);
  expect(error instanceof XMPPError).toBe(true);
  expect(error instanceof SASLError).toBe(true);
  expect(error.name).toBe("SASLError");
  expect(error.condition).toBe("not-authorized");
  expect(error.text).toBe("");
});

test("SASL with text", () => {
  const nonza = (
    <failure xmlns="urn:ietf:params:xml:ns:xmpp-sasl">
      <aborted />
      <text>foo</text>
    </failure>
  );
  expect(SASLError.fromElement(nonza).text).toBe("foo");
});

// https://xmpp.org/extensions/xep-0388.html#failure
// https://github.com/xsf/xeps/pull/1411
// https://xmpp.org/extensions/xep-0388.html#sect-idm46365286031040

test("SASL2", () => {
  const nonza = (
    <failure xmlns="urn:xmpp:sasl:2">
      <aborted xmlns="urn:ietf:params:xml:ns:xmpp-sasl" />
    </failure>
  );

  const error = SASLError.fromElement(nonza);

  expect(error instanceof Error).toBe(true);
  expect(error instanceof XMPPError).toBe(true);
  expect(error instanceof SASLError).toBe(true);
  expect(error.name).toBe("SASLError");
  expect(error.condition).toBe("aborted");
});

test("SASL2 with text and application", () => {
  const application = (
    <optional-application-specific xmlns="urn:something:else" />
  );

  const nonza = (
    <failure xmlns="urn:xmpp:sasl:2">
      <aborted xmlns="urn:ietf:params:xml:ns:xmpp-sasl" />
      <text>This is a terrible example.</text>
      {application}
    </failure>
  );

  const error = SASLError.fromElement(nonza);

  expect(error.text).toBe("This is a terrible example.");
  expect(error.application).toBe(application);
});
