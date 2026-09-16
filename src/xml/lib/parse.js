import parseDocument from "./parseDocument.js";
import XMLError from "./XMLError.js";

export default function parse(data) {
  try {
    return parseDocument(data);
  } catch (error) {
    throw new XMLError(error.message, { cause: error });
  }
}
