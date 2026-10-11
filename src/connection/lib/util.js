const INVALID_REDIRECT_TARGET = "Invalid see-other-host target";

function parseURI(URI) {
  let { port, hostname, protocol } = new URL(URI);
  // https://github.com/nodejs/node/issues/12410#issuecomment-294138912
  if (hostname === "[::1]") {
    hostname = "::1";
  }

  return { port, hostname, protocol };
}

function parseHost(host) {
  const { port, hostname } = parseURI(`http://${host}`);
  return { port, hostname };
}

function parseService(service) {
  return service.includes("://") ? parseURI(service) : parseHost(service);
}

function parseRedirectTarget(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.trim() !== value ||
    /[/?#@]/u.test(value)
  ) {
    throw new TypeError(INVALID_REDIRECT_TARGET);
  }

  let domain = value;
  let port = "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    const suffix = value.slice(end + 1);
    if (end === -1 || (suffix !== "" && !/^:\d+$/u.test(suffix))) {
      throw new TypeError(INVALID_REDIRECT_TARGET);
    }
    domain = value.slice(0, end + 1);
    port = suffix.slice(1);
  } else {
    const separator = value.lastIndexOf(":");
    if (separator !== -1) {
      if (!/^\d+$/u.test(value.slice(separator + 1))) {
        throw new TypeError(INVALID_REDIRECT_TARGET);
      }
      domain = value.slice(0, separator);
      port = value.slice(separator + 1);
    }
  }

  try {
    const { hostname } = parseHost(value);
    return { domain, hostname, port };
  } catch {
    throw new TypeError(INVALID_REDIRECT_TARGET);
  }
}

export {
  INVALID_REDIRECT_TARGET,
  parseURI,
  parseHost,
  parseService,
  parseRedirectTarget,
};
