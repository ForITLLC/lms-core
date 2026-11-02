import { promises as dns } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { isIPv4, isIPv6, type LookupFunction } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

// A server-side GET of a public web page that can't be pointed at the host's
// own network (SSRF; docs/plans/2026-10-29-ai-authoring.md, slice A3). The
// address is checked where the connection is made: the lookup the socket
// connects through refuses a host if any address it resolves to is not
// public, so DNS rebinding can't swap a checked address for another, and the
// address the socket actually reached is checked again before anything is
// read. Every redirect is followed by hand and checked the same way.

export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_MAX_REDIRECTS = 3;

// URL leaves a scheme's default port out.
const PORTS = new Set(["", "80", "443"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH",
]);

// transient: a timeout, a 5xx or 429, a dropped connection; asking again later
// may work. Anything else is a refusal.
export class SafeFetchError extends Error {
  readonly transient: boolean;
  readonly retryAfterMs: number | null;

  constructor(message: string, transient = false, retryAfterMs: number | null = null) {
    super(message);
    this.transient = transient;
    this.retryAfterMs = retryAfterMs;
  }
}

const refused = (message: string) => new SafeFetchError(message, false);
const unavailable = (message: string, retryAfterMs: number | null = null) => new SafeFetchError(message, true, retryAfterMs);

// ---- which addresses are public --------------------------------------------

const v4 = (dotted: string) => dotted.split(".").reduce((n, part) => n * 256 + Number(part), 0);

const V4_METADATA = new Set(["169.254.169.254", "168.63.129.16", "100.100.100.200"].map(v4));
const V4_BLOCKED: [number, number, string][] = ([
  ["0.0.0.0", 8, "an unspecified address"],
  ["10.0.0.0", 8, "a private address"],
  ["100.64.0.0", 10, "a carrier-grade NAT address"],
  ["127.0.0.0", 8, "a loopback address"],
  ["169.254.0.0", 16, "a link-local address"],
  ["172.16.0.0", 12, "a private address"],
  ["192.0.0.0", 24, "a special-purpose address"],
  ["192.0.2.0", 24, "a documentation address"],
  ["192.168.0.0", 16, "a private address"],
  ["198.18.0.0", 15, "a benchmarking address"],
  ["198.51.100.0", 24, "a documentation address"],
  ["203.0.113.0", 24, "a documentation address"],
  ["224.0.0.0", 4, "a multicast address"],
  ["240.0.0.0", 4, "a reserved or broadcast address"],
] as const).map(([base, bits, why]) => [v4(base), bits, why]);

function blockedV4(n: number): string | null {
  if (V4_METADATA.has(n)) return "a cloud metadata address";
  for (const [base, bits, why] of V4_BLOCKED) {
    const size = 2 ** (32 - bits);
    if (n >= base && n < base + size) return why;
  }
  return null;
}

// Eight 16-bit groups, or null when the text is not an IPv6 address.
function v6Groups(address: string): number[] | null {
  let s = address.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!isIPv6(s)) return null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const n = v4(tail);
    s = `${s.slice(0, lastColon + 1)}${(Math.floor(n / 65536)).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const halves = s.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array<string>(Math.max(0, fill)).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

const V6_METADATA = v6Groups("fd00:ec2::254")!;

function blockedV6(g: number[]): string | null {
  const at = (i: number) => g[i] ?? 0;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const embedded = at(6) * 65536 + at(7);
  if (g.every((x, i) => x === V6_METADATA[i])) return "a cloud metadata address";
  // IPv4-mapped (::ffff:a.b.c.d) and translated (::ffff:0:a.b.c.d) forms reach
  // the IPv4 address they carry; NAT64 (64:ff9b::a.b.c.d) and 6to4
  // (2002:aabb:ccdd::) are routed to it.
  if (zeros(0, 5) && at(5) === 0xffff) return blockedV4(embedded);
  if (zeros(0, 4) && at(4) === 0xffff && at(5) === 0) return blockedV4(embedded);
  if (at(0) === 0x64 && at(1) === 0xff9b && zeros(2, 6)) return blockedV4(embedded);
  if (at(0) === 0x2002) {
    const why = blockedV4(at(1) * 65536 + at(2));
    if (why) return why;
  }
  if (zeros(0, 8)) return "an unspecified address";
  if (zeros(0, 7) && at(7) === 1) return "a loopback address";
  if (zeros(0, 6)) return "an IPv4-compatible address";
  if ((at(0) & 0xffc0) === 0xfe80) return "a link-local address";
  if ((at(0) & 0xffc0) === 0xfec0) return "a site-local address";
  if ((at(0) & 0xfe00) === 0xfc00) return "a unique-local address";
  if ((at(0) & 0xff00) === 0xff00) return "a multicast address";
  if (at(0) === 0x2001 && at(1) === 0x0db8) return "a documentation address";
  if ((at(0) & 0xe000) !== 0x2000) return "not a global unicast address";
  return null;
}

// Why an address may not be fetched from, or null when it is public.
export function blockedAddress(address: string): string | null {
  const bare = address.replace(/^\[(.*)\]$/, "$1");
  if (isIPv4(bare)) return blockedV4(v4(bare));
  const groups = v6Groups(bare);
  return groups ? blockedV6(groups) : "not an IP address";
}

// ---- the address check, at parse time and at connect time -----------------

// The scheme, port and any address written into the URL itself, for the first
// request and every redirect. A host name is checked when it is looked up.
export function checkFetchUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw refused("That is not a valid web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw refused(`Only http and https addresses can be fetched, not ${url.protocol.replace(/:$/, "")}.`);
  }
  if (url.username || url.password) throw refused("A web address with a user name or password can't be fetched.");
  if (!PORTS.has(url.port)) throw refused(`Only ports 80 and 443 can be fetched, not ${url.port}.`);
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!host) throw refused("The web address has no host.");
  if (isIPv4(host) || isIPv6(host)) {
    const why = blockedAddress(host);
    if (why) throw refused(`The web address is ${why}; only public addresses can be fetched.`);
  }
  url.hash = "";
  return url;
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const systemResolver: Resolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

// The lookup the socket connects through: every address the host resolves to
// must be public, and the socket can only connect to one of them.
export function guardedLookup(resolve: Resolver): LookupFunction {
  return (hostname, options, callback) => {
    const pass = (found: { address: string; family: number }[]) => {
      if (found.length === 0) throw refused(`No address found for ${hostname}.`);
      for (const { address } of found) {
        const why = blockedAddress(address);
        if (why) throw refused(`${hostname} resolves to ${why}; only public addresses can be fetched.`);
      }
      const family = options.family === 4 || options.family === "IPv4" ? 4 : options.family === 6 || options.family === "IPv6" ? 6 : 0;
      const usable = found.filter((a) => !family || a.family === family).map((a) => ({ address: a.address, family: a.family }));
      if (usable.length === 0) throw refused(`No IPv${family} address found for ${hostname}.`);
      return usable;
    };
    resolve(hostname).then(pass).then(
      (usable) => (options.all ? callback(null, usable) : callback(null, usable[0]!.address, usable[0]!.family)),
      (err: NodeJS.ErrnoException) => callback(err, "", 0),
    );
  };
}

function checkConnected(remoteAddress: string | undefined): void {
  const why = remoteAddress ? blockedAddress(remoteAddress) : "an address that couldn't be confirmed";
  if (why) throw refused(`The connection reached ${why}; only public addresses can be fetched.`);
}

// ---- the request -----------------------------------------------------------

export interface TransportRequest {
  url: URL;
  headers: Record<string, string>;
  // The connection must resolve the host through this lookup.
  lookup: LookupFunction;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  // The address the connection reached.
  remoteAddress: string | undefined;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

// node:http and node:https, one fresh socket per request (no shared agent, so
// no pooled socket from another host is reused).
const nodeTransport: Transport = ({ url, headers, lookup, signal }) =>
  new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https.request : http.request)(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        lookup,
        agent: false,
        signal,
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          remoteAddress: res.socket?.remoteAddress,
          body: res,
          destroy: () => res.destroy(),
        });
      },
    );
    request.on("error", reject);
    request.end();
  });

export interface SafeFetchOptions {
  // Media types the caller reads, such as text/html.
  accept: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  resolve?: Resolver;
  transport?: Transport;
}

export interface SafeResponse {
  url: string;
  status: number;
  mediaType: string;
  charset: string | null;
  body: Buffer;
}

function header(headers: TransportResponse["headers"], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function retryAfterMs(value: string | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : null;
}

const megabytes = (bytes: number) => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;

const OPENERS: Record<string, (body: Buffer, options: { maxOutputLength: number }) => Buffer> = {
  gzip: gunzipSync,
  "x-gzip": gunzipSync,
  deflate: inflateSync,
  br: brotliDecompressSync,
};

// A body the server compressed although asked not to, opened no further than
// the cap.
function decoded(body: Buffer, encoding: string | undefined, maxBytes: number): Buffer {
  const coding = (encoding ?? "").trim().toLowerCase();
  if (coding === "identity" || coding === "") return body;
  const open = OPENERS[coding];
  if (!open) throw refused(`The page is sent with an encoding that can't be read (${coding}).`);
  try {
    return open(body, { maxOutputLength: maxBytes });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw refused(`The page is larger than ${megabytes(maxBytes)}.`);
    throw refused("The page's compressed body can't be read.");
  }
}

export async function safeFetch(input: string, options: SafeFetchOptions): Promise<SafeResponse> {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? FETCH_MAX_REDIRECTS;
  const transport = options.transport ?? nodeTransport;
  const lookup = guardedLookup(options.resolve ?? systemResolver);
  const accept = options.accept.map((type) => type.toLowerCase());
  const headers = {
    "user-agent": "Mozilla/5.0 (compatible; course-source-reader/1.0)",
    accept: accept.join(", "),
    "accept-encoding": "identity",
  };

  const timedOut = () => unavailable(`The page didn't answer within ${Math.round(timeoutMs / 1000)} s.`);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timedOut());
    }, timeoutMs);
  });
  deadline.catch(() => undefined);
  const within = <T>(work: Promise<T>) => Promise.race([work, deadline]);

  try {
    let url = checkFetchUrl(input);
    for (let redirects = 0; ; redirects++) {
      const response = await within(transport({ url, headers, lookup, signal: controller.signal }));
      try {
        checkConnected(response.remoteAddress);
        if (REDIRECTS.has(response.status)) {
          if (redirects >= maxRedirects) throw refused(`The page redirects more than ${maxRedirects} times.`);
          const location = header(response.headers, "location");
          if (!location) throw refused(`The page answered ${response.status} with nowhere to go.`);
          url = checkFetchUrl(new URL(location, url));
          continue;
        }
        if (response.status === 429 || response.status >= 500) {
          throw unavailable(`The page answered ${response.status}.`, retryAfterMs(header(response.headers, "retry-after")));
        }
        if (response.status < 200 || response.status > 299) throw refused(`The page answered ${response.status}.`);

        const [type = "", ...params] = (header(response.headers, "content-type") ?? "").split(";");
        const mediaType = type.trim().toLowerCase();
        if (!accept.includes(mediaType)) {
          throw refused(`The page is ${mediaType || "of no stated type"}; only ${accept.join(" or ")} can be read.`);
        }
        const charset = params.map((p) => /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(p)?.[1]).find(Boolean) ?? null;
        const declared = Number(header(response.headers, "content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) throw refused(`The page is larger than ${megabytes(maxBytes)}.`);

        const chunks: Buffer[] = [];
        let size = 0;
        const reader = response.body[Symbol.asyncIterator]();
        for (;;) {
          const next = await within(reader.next());
          if (next.done) break;
          size += next.value.byteLength;
          if (size > maxBytes) throw refused(`The page is larger than ${megabytes(maxBytes)}.`);
          chunks.push(Buffer.from(next.value));
        }
        const body = decoded(Buffer.concat(chunks), header(response.headers, "content-encoding"), maxBytes);
        return { url: url.href, status: response.status, mediaType, charset, body };
      } finally {
        response.destroy();
      }
    }
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    if (controller.signal.aborted) throw timedOut();
    const code = (err as NodeJS.ErrnoException)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === "ENOTFOUND") throw refused(`No such host: ${message.replace(/^getaddrinfo ENOTFOUND /, "")}.`);
    if (code && TRANSIENT_CODES.has(code)) throw unavailable(`The page couldn't be reached (${code}).`);
    throw refused(`The page couldn't be fetched: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Bytes 0x80-0x9F in Windows-1252, which browsers also read ISO-8859-1 and
// US-ASCII as. Node 20's TextDecoder turns them into Latin-1 control
// characters, so they are mapped here.
export const CP1252 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

// The body as text, in the charset the page declared, else UTF-8.
export function decodeText(body: Buffer, charset: string | null): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset ?? "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  if (decoder.encoding !== "windows-1252") return decoder.decode(body);
  return body.toString("latin1").replace(/[\x80-\x9f]/g, (c) => String.fromCharCode(CP1252[c.charCodeAt(0) - 0x80]!));
}
