import JID from "./JID.js";
import { prepareLocal } from "./precis.js";

export default function parse(s) {
  let local;
  let resource;

  const resourceStart = s.indexOf("/");
  if (resourceStart !== -1) {
    resource = s.slice(resourceStart + 1);
    if (!resource) {
      throw new TypeError("Empty JID resourcepart.");
    }
    s = s.slice(0, resourceStart);
  }

  const atStart = s.indexOf("@");
  if (atStart !== -1) {
    local = s.slice(0, atStart);
    // Wire addresses are not user input for XEP-0106 automatic escaping.
    local = prepareLocal(local);
    s = s.slice(atStart + 1);
  }

  return new JID(local, s, resource);
}
