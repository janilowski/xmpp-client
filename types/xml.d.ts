import type { ElementConstructor, XMLFactory } from "./index.js";

export type {
  Element,
  ElementConstructor,
  XMLAttributes,
  XMLAttributeValue,
  XMLChild,
  XMLFactory,
} from "./index.js";

export declare const Element: ElementConstructor;
export declare const createElement: XMLFactory;
export declare const xml: XMLFactory;
export declare const escapeXML: (value: string) => string;
export declare const unescapeXML: (value: string) => string;
export declare const escapeXMLText: (value: string) => string;
export declare const unescapeXMLText: (value: string) => string;

export default xml;
