import { SaxesParser } from "saxes";

export function validateReport(source: string) {
  new SaxesParser().write(source).close();
}
