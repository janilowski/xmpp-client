import { SaxesParser } from "saxes";
import Element from "ltx/lib/Element.js";
import { EventEmitter } from "../../events/index.js";

import XMLError from "./XMLError.js";

class Parser extends EventEmitter {
  #failed = false;

  constructor() {
    super();
    const parser = new SaxesParser({ xmlns: true });
    this.root = null;
    this.cursor = null;

    parser.on("opentag", ({ name, attributes }) => {
      this.onStartElement(
        name,
        Object.fromEntries(
          Object.values(attributes).map(({ name, value }) => [name, value]),
        ),
      );
    });
    parser.on("closetag", ({ name }) => this.onEndElement(name));
    parser.on("text", this.onText.bind(this));
    parser.on("cdata", this.onText.bind(this));
    parser.on("error", (error) => {
      if (this.#failed) {
        return;
      }
      // Saxes can recover; this adapter must stop emitting after invalid XML.
      this.#failed = true;
      this.emit("error", new XMLError(error.message, { cause: error }));
    });

    this.parser = parser;
  }

  onStartElement(name, attrs) {
    if (this.#failed) {
      return;
    }
    const element = new Element(name, attrs);

    const { root, cursor } = this;

    if (!root) {
      this.root = element;
      this.emit("start", element);
    } else if (cursor !== root) {
      cursor.append(element);
    }

    this.cursor = element;
  }

  onEndElement(name) {
    if (this.#failed) {
      return;
    }
    const { root, cursor } = this;
    if (name !== cursor.name) {
      // <foo></bar>
      this.emit("error", new XMLError(`${cursor.name} must be closed.`));
      return;
    }

    if (cursor === root) {
      this.emit("end", root);
      return;
    }

    if (!cursor.parent) {
      cursor.parent = root;
      this.emit("element", cursor);
      this.cursor = root;
      return;
    }

    this.cursor = cursor.parent;
  }

  onText(str) {
    if (this.#failed) {
      return;
    }
    const { cursor } = this;
    if (!cursor) {
      this.emit("error", new XMLError(`${str} must be a child.`));
      return;
    }

    cursor.t(str);
  }

  write(data) {
    if (!this.#failed) {
      this.parser.write(data);
    }
  }

  end(data) {
    if (data) {
      this.write(data);
    }
    if (!this.#failed) {
      this.parser.close();
    }
  }
}

Parser.XMLError = XMLError;

export default Parser;
