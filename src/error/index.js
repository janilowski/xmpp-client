// https://xmpp.org/rfcs/rfc6120.html#rfc.section.4.9.2

class XMPPError extends Error {
  constructor(condition, text, application) {
    super(condition + (text ? ` - ${text}` : ""));
    this.name = "XMPPError";
    this.condition = condition;
    this.text = text;
    this.application = application;
  }

  static fromElement(element, namespace, known) {
    const children = element.getChildElements();
    namespace ??= children[0]?.getNS();
    const conditions = children.filter(
      (child) => child.getNS() === namespace && !child.is("text", namespace),
    );
    const condition = conditions.length === 1 && conditions[0].getName();
    const error = new this(
      condition && (!known || known.has(condition))
        ? condition
        : "undefined-condition",
      element.getChildText("text", namespace) ?? "",
      children.find((child) => child.getNS() !== namespace),
    );
    error.element = element;
    return error;
  }
}

export default XMPPError;
