import { expect } from "bun:test";
import { client } from "../../src/client/index.js";
import type { DiscoInfo } from "../../types/index.js";
import { ScriptedPeer } from "../peer.ts";
import { readFrame } from "../xml.ts";
import { INFO, SIMPLE_SHA1, SIMPLE_XML } from "./fixture.ts";

export const CAPS = "http://jabber.org/protocol/caps";
export const CLIENT = "jabber:client";
export const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
export const STREAM = "http://etherx.jabber.org/streams";
export const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
export const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
export const PING = "urn:xmpp:ping";
export const NODE = "https://example.test/software";
export const OWN_NODE = "https://example.test/app";
export const TARGET = "peer@remote.test/device";
export const OTHER = "other@remote.test/resource";
export const FULL_JID = "user@example.test/client";
export const TIMEOUT_MS = 300;
const WATCHDOG_MS = TIMEOUT_MS * 3;

// The API is asserted before use, so an absent implementation fails an assertion.
export interface CapabilityResult {
  jid: string;
  node: string;
  ver: string;
  hash: string;
  status: "pending" | "verified" | "unverified" | "invalid";
  info?: DiscoInfo;
  error?: Error;
}

export interface CapabilityService {
  get(jid: string): CapabilityResult | undefined;
}

export function capabilities(
  xmpp: ReturnType<typeof client>,
): CapabilityService {
  expect(xmpp).toHaveProperty("caps");
  const value = (xmpp as unknown as { caps: CapabilityService }).caps;
  expect(value).toHaveProperty("get");
  return value;
}

export interface DiscoveryRequest {
  id: string;
  to?: string;
  node?: string;
  frame: string;
}

// Literal peer replies are independent of the capabilities implementation.
export class ReceivingPeer {
  readonly peer: ScriptedPeer;
  readonly queries: DiscoveryRequest[] = [];
  onQuery?: (request: DiscoveryRequest) => void;
  private barrierId = 0;

  constructor(initialCaps = "") {
    let authenticated = false;
    this.peer = new ScriptedPeer((frame, remote) => {
      const events = readFrame(frame);
      const root = events[0];
      if (!("open" in root)) {
        throw new Error("Expected client element");
      }
      if (root.open === `{${FRAMING}}open`) {
        remote.send(
          `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="receiving"/>`,
        );
        remote.send(
          `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}${initialCaps}</features>`,
        );
      } else if (root.open === `{${SASL}}auth`) {
        authenticated = true;
        remote.send(`<success xmlns="${SASL}"/>`);
      } else if (
        root.open === `{${CLIENT}}iq` &&
        events.some(
          (event) => "open" in event && event.open === `{${BIND}}bind`,
        )
      ) {
        remote.send(
          `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>${FULL_JID}</jid></bind></iq>`,
        );
      } else if (
        root.open === `{${CLIENT}}iq` &&
        root.attributes["{}type"] === "get"
      ) {
        const query = events.find(
          (event) => "open" in event && event.open === `{${INFO}}query`,
        );
        if (query && "open" in query) {
          const request = {
            id: root.attributes["{}id"],
            to: root.attributes["{}to"],
            node: query.attributes["{}node"],
            frame,
          };
          this.queries.push(request);
          this.onQuery?.(request);
        }
      } else if (root.open === `{${FRAMING}}close`) {
        remote.send(`<close xmlns="${FRAMING}"/>`);
      }
    });
  }

  advertise({
    jid = TARGET,
    node = NODE,
    ver = SIMPLE_SHA1,
    hash = "sha-1",
  } = {}) {
    this.peer.send(
      `<presence xmlns="${CLIENT}" from="${jid}"><c xmlns="${CAPS}" node="${node}" hash="${hash}" ver="${ver}"/></presence>`,
    );
  }

  answer(request: DiscoveryRequest, source = SIMPLE_XML, from = request.to) {
    const payload = source
      .replace(/ node="[^"]*"/, "")
      .replace("<query ", `<query node="${request.node}" `);
    this.peer.send(
      `<iq xmlns="${CLIENT}" type="result" id="${request.id}"${from === undefined ? "" : ` from="${from}"`}>${payload}</iq>`,
    );
  }

  async nextQuery(): Promise<DiscoveryRequest> {
    for (;;) {
      const frame = await this.peer.next();
      const events = readFrame(frame);
      const root = events[0];
      if (
        !("open" in root) ||
        root.open !== `{${CLIENT}}iq` ||
        root.attributes["{}type"] !== "get"
      ) {
        continue;
      }
      const query = events.find(
        (event) => "open" in event && event.open === `{${INFO}}query`,
      );
      if (query && "open" in query) {
        return {
          id: root.attributes["{}id"],
          to: root.attributes["{}to"],
          node: query.attributes["{}node"],
          frame,
        };
      }
    }
  }

  // The client must process a later inbound IQ and its wire reply, not a sleep.
  async barrier() {
    const id = `caps-barrier-${++this.barrierId}`;
    this.peer.send(
      `<iq xmlns="${CLIENT}" type="get" id="${id}" from="example.test"><ping xmlns="${PING}"/></iq>`,
    );
    for (;;) {
      const root = readFrame(await this.peer.next())[0];
      if ("open" in root && root.attributes["{}id"] === id) {
        expect(root).toMatchObject({
          open: `{${CLIENT}}iq`,
          attributes: { "{}type": "result" },
        });
        return;
      }
    }
  }
}

export async function result(
  xmpp: ReturnType<typeof client>,
  jid: string,
  status: CapabilityResult["status"],
): Promise<CapabilityResult> {
  const api = capabilities(xmpp);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onResult: (value: CapabilityResult) => void;
  const observed = await new Promise<CapabilityResult | undefined>(
    (resolve) => {
      onResult = (value) => {
        if (value.jid === jid && value.status === status) {
          resolve(value);
        }
      };
      xmpp.on("capabilities", onResult);
      const current = api.get(jid);
      if (current?.status === status) {
        resolve(current);
      }
      timer = setTimeout(() => resolve(api.get(jid)), WATCHDOG_MS);
    },
  ).finally(() => {
    clearTimeout(timer);
    xmpp.off("capabilities", onResult);
  });
  expect(observed).toMatchObject({ jid, status });
  return observed!;
}

export async function receivingSession(
  exercise: (
    xmpp: ReturnType<typeof client>,
    remote: ReceivingPeer,
    errors: Error[],
  ) => Promise<void>,
  mode: "enabled" | "disabled" = "enabled",
  initialCaps = "",
) {
  const remote = new ReceivingPeer(initialCaps);
  const xmpp = client({
    service: remote.peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
    disco: { identities: [{ category: "client", type: "web", name: "Test" }] },
    ...(mode === "enabled" ? { caps: { node: OWN_NODE } } : {}),
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    expect(String(await xmpp.start())).toBe(FULL_JID);
    await exercise(xmpp, remote, errors);
    expect(errors).toEqual([]);
    expect(remote.peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await remote.peer.stop();
  }
}
