export default function getDomain(service) {
  const authority = service
    .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
    .split(/[/?#]/, 1)[0];
  if (!authority.startsWith("[")) {
    return authority.split(":")[0];
  }

  // Preserve literal colons and leave host preparation to the JID layer.
  const end = authority.indexOf("]");
  if (end === -1 || !/^(?::\d*)?$/.test(authority.slice(end + 1))) {
    throw new TypeError("Invalid service authority");
  }
  return authority.slice(0, end + 1);
}
