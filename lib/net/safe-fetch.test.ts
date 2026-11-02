import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { fakeWeb, type FakePage } from "@/lib/fixtures/fake-web";
import {
  blockedAddress,
  checkFetchUrl,
  decodeText,
  FETCH_MAX_BYTES,
  guardedLookup,
  safeFetch,
  SafeFetchError,
  type SafeFetchOptions,
} from "./safe-fetch";

// SSRF guards for the web page source (docs/plans/2026-10-29-ai-authoring.md,
// slice A3), against a fake resolver and a server-free transport.

const PUBLIC_V4 = "93.184.215.14";
const PUBLIC_V6 = "2606:2800:21f:cb07:6820:80da:af6b:8b2c";
const HTML = { "content-type": "text/html; charset=utf-8" };
const page = (body: string): FakePage => ({ headers: HTML, body });

const DNS: Record<string, string[]> = {
  "pages.example": [PUBLIC_V4],
  "v6.example": [PUBLIC_V6],
  "other.example": [PUBLIC_V4],
  "intranet.example": ["10.0.0.5"],
  "loop.example": ["127.0.0.1"],
  "loop6.example": ["::1"],
  "mapped.example": ["::ffff:10.0.0.5"],
  "metadata.example": ["169.254.169.254"],
  "metadata6.example": ["fd00:ec2::254"],
  "wireserver.example": ["168.63.129.16"],
  "mixed.example": [PUBLIC_V4, "192.168.1.10"],
};

function web(pages: Record<string, FakePage> = {}) {
  const w = fakeWeb(DNS, pages);
  const options = (more: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({
    accept: ["text/html", "text/plain"], resolve: w.resolve, transport: w.transport, ...more,
  });
  return { ...w, options, get destroyed() { return w.destroyed; } };
}

async function refusal(work: Promise<unknown>, pattern: RegExp, transient = false) {
  await assert.rejects(work, (err: unknown) => {
    assert.ok(err instanceof SafeFetchError, String(err));
    assert.match(err.message, pattern);
    assert.equal(err.transient, transient, err.message);
    return true;
  });
}

// ---- which addresses are public -----------------------------------------------

const BLOCKED: [string, string][] = [
  ["0.0.0.0", "an unspecified address"],
  ["0.1.2.3", "an unspecified address"],
  ["127.0.0.1", "a loopback address"],
  ["127.255.255.254", "a loopback address"],
  ["10.0.0.1", "a private address"],
  ["10.255.255.255", "a private address"],
  ["172.16.0.1", "a private address"],
  ["172.31.255.255", "a private address"],
  ["192.168.0.1", "a private address"],
  ["192.168.255.255", "a private address"],
  ["169.254.0.1", "a link-local address"],
  ["169.254.255.255", "a link-local address"],
  ["100.64.0.1", "a carrier-grade NAT address"],
  ["100.127.255.255", "a carrier-grade NAT address"],
  ["224.0.0.1", "a multicast address"],
  ["239.255.255.250", "a multicast address"],
  ["255.255.255.255", "a reserved or broadcast address"],
  ["240.0.0.1", "a reserved or broadcast address"],
  ["169.254.169.254", "a cloud metadata address"],
  ["168.63.129.16", "a cloud metadata address"],
  ["::", "an unspecified address"],
  ["::1", "a loopback address"],
  ["fe80::1", "a link-local address"],
  ["fe80::1%eth0", "a link-local address"],
  ["febf:ffff::1", "a link-local address"],
  ["fc00::1", "a unique-local address"],
  ["fd12:3456:789a::1", "a unique-local address"],
  ["ff02::1", "a multicast address"],
  ["ff05::1:3", "a multicast address"],
  ["fd00:ec2::254", "a cloud metadata address"],
  ["[::1]", "a loopback address"],
  // IPv4-mapped (and translated) forms carry the IPv4 address's verdict.
  ["::ffff:127.0.0.1", "a loopback address"],
  ["::ffff:7f00:1", "a loopback address"],
  ["::FFFF:7F00:0001", "a loopback address"],
  ["0:0:0:0:0:ffff:127.0.0.1", "a loopback address"],
  ["[::ffff:127.0.0.1]", "a loopback address"],
  ["::ffff:0.0.0.0", "an unspecified address"],
  ["::ffff:10.0.0.1", "a private address"],
  ["::ffff:172.16.0.1", "a private address"],
  ["::ffff:192.168.1.1", "a private address"],
  ["::ffff:169.254.0.1", "a link-local address"],
  ["::ffff:100.64.0.1", "a carrier-grade NAT address"],
  ["::ffff:224.0.0.1", "a multicast address"],
  ["::ffff:255.255.255.255", "a reserved or broadcast address"],
  ["::ffff:169.254.169.254", "a cloud metadata address"],
  ["::ffff:a9fe:a9fe", "a cloud metadata address"],
  ["::ffff:168.63.129.16", "a cloud metadata address"],
  ["::ffff:0:127.0.0.1", "a loopback address"],
  ["64:ff9b::10.0.0.1", "a private address"],
  ["64:ff9b::a9fe:a9fe", "a cloud metadata address"],
  ["2002:7f00:1::1", "a loopback address"],
  ["::127.0.0.1", "an IPv4-compatible address"],
];

test("every blocked range is refused, IPv4-mapped forms by the address they carry, metadata addresses by name", () => {
  for (const [address, why] of BLOCKED) assert.equal(blockedAddress(address), why, address);
});

test("public addresses pass, including mapped and NAT64 forms of a public IPv4 address, and range edges just outside", () => {
  for (const address of [
    PUBLIC_V4, "8.8.8.8", "1.1.1.1", "9.255.255.255", "11.0.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255",
    "192.169.0.0", "169.253.255.255", "169.255.0.0", "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0",
    "223.255.255.255", PUBLIC_V6, "2606:4700:4700::1111", "::ffff:8.8.8.8", "::ffff:5db8:d70e", "64:ff9b::8.8.8.8",
  ]) {
    assert.equal(blockedAddress(address), null, address);
  }
  assert.equal(blockedAddress("pages.example"), "not an IP address");
  assert.equal(blockedAddress(""), "not an IP address");
});

// ---- the address as written ------------------------------------------------------

test("only http and https on ports 80 and 443, with no credentials and no blocked address written in, are fetched", () => {
  for (const url of ["ftp://pages.example/x", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "gopher://pages.example/", "ws://pages.example/"]) {
    assert.throws(() => checkFetchUrl(url), /Only http and https addresses can be fetched/, url);
  }
  for (const url of ["http://pages.example:8080/", "https://pages.example:8443/", "http://pages.example:22/", "https://pages.example:0/"]) {
    assert.throws(() => checkFetchUrl(url), /Only ports 80 and 443 can be fetched/, url);
  }
  assert.throws(() => checkFetchUrl("https://user:pass@pages.example/"), /user name or password/);
  assert.throws(() => checkFetchUrl("not a url"), /not a valid web address/);
  for (const [url, why] of [
    ["http://127.0.0.1/", "a loopback address"],
    ["http://2130706433/", "a loopback address"],
    ["http://0x7f.1/", "a loopback address"],
    ["http://[::1]/", "a loopback address"],
    ["http://[::ffff:127.0.0.1]/", "a loopback address"],
    ["http://169.254.169.254/latest/meta-data/", "a cloud metadata address"],
    ["http://[fd00:ec2::254]/", "a cloud metadata address"],
    ["http://10.1.2.3/", "a private address"],
  ] as const) {
    assert.throws(() => checkFetchUrl(url), new RegExp(`The web address is ${why}`), url);
  }
  assert.equal(checkFetchUrl("https://pages.example:443/a?b=1#frag").href, "https://pages.example/a?b=1");
  assert.equal(checkFetchUrl("http://pages.example:80/").href, "http://pages.example/");
  assert.equal(checkFetchUrl(`http://[${PUBLIC_V6}]/`).hostname, `[${PUBLIC_V6}]`);
});

test("a non-http scheme and a port other than 80 or 443 are refused before anything is looked up or connected", async () => {
  const w = web();
  await refusal(safeFetch("ftp://pages.example/notes.txt", w.options()), /Only http and https/);
  await refusal(safeFetch("http://pages.example:8080/", w.options()), /Only ports 80 and 443/);
  await refusal(safeFetch("http://127.0.0.1/", w.options()), /The web address is a loopback address/);
  await refusal(safeFetch("http://[::ffff:169.254.169.254]/", w.options()), /a cloud metadata address/);
  assert.deepEqual([w.lookups, w.connections], [[], []]);
});

// ---- the address connected to ---------------------------------------------------

test("a host that resolves to a blocked address is refused in the lookup the socket connects through: nothing is connected", async () => {
  for (const [host, why] of [
    ["intranet.example", "a private address"],
    ["loop.example", "a loopback address"],
    ["loop6.example", "a loopback address"],
    ["mapped.example", "a private address"],
    ["metadata.example", "a cloud metadata address"],
    ["metadata6.example", "a cloud metadata address"],
    ["wireserver.example", "a cloud metadata address"],
    ["mixed.example", "a private address"],
  ] as const) {
    const w = web({ [`http://${host}/`]: page("secret") });
    await refusal(safeFetch(`http://${host}/`, w.options()), new RegExp(`^${host.replace(/\./g, "\\.")} resolves to ${why}`));
    assert.deepEqual(w.lookups, [host]);
    assert.deepEqual(w.connections, [], host);
  }
});

test("the lookup answers what the socket asked for, one address or all, of the family it asked for", async () => {
  const lookup = guardedLookup(async () => [{ address: PUBLIC_V4, family: 4 }, { address: PUBLIC_V6, family: 6 }]);
  const ask = (options: object) => new Promise<unknown[]>((resolve) => lookup("pages.example", options, (...args) => resolve(args)));
  assert.deepEqual(await ask({}), [null, PUBLIC_V4, 4]);
  assert.deepEqual(await ask({ family: 6 }), [null, PUBLIC_V6, 6]);
  assert.deepEqual(await ask({ all: true }), [null, [{ address: PUBLIC_V4, family: 4 }, { address: PUBLIC_V6, family: 6 }]]);
  const blocked = guardedLookup(async () => [{ address: "10.9.8.7", family: 4 }]);
  const [err] = await new Promise<unknown[]>((resolve) => blocked("intranet.example", { all: true }, (...args) => resolve(args)));
  assert.ok(err instanceof SafeFetchError && /resolves to a private address/.test(err.message));
});

test("the address the socket actually reached is checked before anything is read, so a swapped address is refused", async () => {
  let pulled = 0;
  const w = web({ "https://pages.example/": { headers: HTML, remoteAddress: "127.0.0.1", chunks: async function* () { pulled += 1; yield Buffer.from("secret"); } } });
  await refusal(safeFetch("https://pages.example/", w.options()), /The connection reached a loopback address/);
  assert.equal(pulled, 0);
  const mapped = web({ "https://pages.example/": { headers: HTML, body: "x", remoteAddress: "::ffff:10.0.0.5" } });
  await refusal(safeFetch("https://pages.example/", mapped.options()), /The connection reached a private address/);
  const unknown = web({ "https://pages.example/": { headers: HTML, body: "x", remoteAddress: "" } });
  await refusal(safeFetch("https://pages.example/", unknown.options()), /couldn't be confirmed/);
});

// ---- redirects ---------------------------------------------------------------------

const to = (location: string, status = 302): FakePage => ({ status, headers: { location } });

test("each redirect is checked like the first address: a private host, a metadata address, another port or scheme are refused", async () => {
  const cases: [string, RegExp][] = [
    ["http://intranet.example/admin", /^intranet\.example resolves to a private address/],
    ["http://169.254.169.254/latest/meta-data/", /The web address is a cloud metadata address/],
    ["http://[::ffff:127.0.0.1]/", /The web address is a loopback address/],
    ["http://other.example:8080/", /Only ports 80 and 443/],
    ["ftp://other.example/file", /Only http and https/],
    ["file:///etc/passwd", /Only http and https/],
  ];
  for (const [location, pattern] of cases) {
    const w = web({ "https://pages.example/start": to(location), [location]: page("should never be read") });
    await refusal(safeFetch("https://pages.example/start", w.options()), pattern);
    assert.deepEqual(w.connections.map((c) => c.url), ["https://pages.example/start"], location);
  }
});

test("up to three redirects are followed by hand, relative ones too; a fourth is refused", async () => {
  const three = web({
    "https://pages.example/a": to("/b", 301),
    "https://pages.example/b": to("https://other.example/c", 307),
    "https://other.example/c": to("http://pages.example/d", 308),
    "http://pages.example/d": page("<p>arrived</p>"),
  });
  const ok = await safeFetch("https://pages.example/a", three.options());
  assert.equal(ok.url, "http://pages.example/d");
  assert.equal(ok.body.toString(), "<p>arrived</p>");
  assert.equal(three.connections.length, 4);
  assert.equal(three.destroyed, 4, "every response is closed");

  const four = web({
    "https://pages.example/1": to("/2"),
    "https://pages.example/2": to("/3"),
    "https://pages.example/3": to("/4"),
    "https://pages.example/4": to("/5"),
    "https://pages.example/5": page("never"),
  });
  await refusal(safeFetch("https://pages.example/1", four.options()), /redirects more than 3 times/);
  assert.deepEqual(four.connections.map((c) => c.url), ["/1", "/2", "/3", "/4"].map((p) => `https://pages.example${p}`));

  const nowhere = web({ "https://pages.example/": { status: 302 } });
  await refusal(safeFetch("https://pages.example/", nowhere.options()), /answered 302 with nowhere to go/);
});

// ---- the body ------------------------------------------------------------------

test("a body over 2 MB is cut off as it streams and refused; one with a Content-Length over it is refused unread", async () => {
  const chunk = Buffer.alloc(64 * 1024, 97);
  let pulled = 0;
  const w = web({ "https://pages.example/big": { headers: HTML, chunks: async function* () {
    for (let i = 0; i < 160; i++) {
      pulled += 1;
      yield chunk;
    }
  } } });
  await refusal(safeFetch("https://pages.example/big", w.options()), /larger than 2 MB/);
  assert.equal(pulled, FETCH_MAX_BYTES / chunk.length + 1, "reading stopped at the chunk that crossed the cap");
  assert.equal(w.destroyed, 1);

  let pulledDeclared = 0;
  const declared = web({ "https://pages.example/big": { headers: { ...HTML, "content-length": String(FETCH_MAX_BYTES + 1) }, chunks: async function* () {
    pulledDeclared += 1;
    yield chunk;
  } } });
  await refusal(safeFetch("https://pages.example/big", declared.options()), /larger than 2 MB/);
  assert.equal(pulledDeclared, 0);

  const exact = web({ "https://pages.example/full": { headers: HTML, body: Buffer.alloc(FETCH_MAX_BYTES, 98) } });
  assert.equal((await safeFetch("https://pages.example/full", exact.options())).body.length, FETCH_MAX_BYTES);

  const bomb = web({ "https://pages.example/z": { headers: { ...HTML, "content-encoding": "gzip" }, body: gzipSync(Buffer.alloc(FETCH_MAX_BYTES + 1, 32)) } });
  await refusal(safeFetch("https://pages.example/z", bomb.options()), /larger than 2 MB/);
  const zipped = web({ "https://pages.example/z": { headers: { ...HTML, "content-encoding": "gzip" }, body: gzipSync("<p>hi</p>") } });
  assert.equal((await safeFetch("https://pages.example/z", zipped.options())).body.toString(), "<p>hi</p>");
});

test("only text/html and text/plain are read; the charset is taken from the type", async () => {
  for (const type of ["application/json", "image/png", "application/pdf", "text/xml", "text/htmlx", ""]) {
    const w = web({ "https://pages.example/": { headers: type ? { "content-type": type } : {}, body: "x" } });
    await refusal(safeFetch("https://pages.example/", w.options()), /only text\/html or text\/plain can be read/, false);
  }
  const latin = web({ "https://pages.example/": { headers: { "content-type": "Text/HTML; Charset=\"ISO-8859-1\"" }, body: "x" } });
  const res = await safeFetch("https://pages.example/", latin.options());
  assert.deepEqual([res.mediaType, res.charset], ["text/html", "ISO-8859-1"]);
});

test("Windows-1252 and the labels browsers read as it map 0x80-0x9F to their characters on every Node version", () => {
  const high = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x80 + i));
  const expected = "€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8dŽ\x8f\x90‘’“”•–—˜™š›œ\x9džŸ";
  for (const label of ["windows-1252", "ISO-8859-1", "latin1", "us-ascii", "cp1252"]) {
    assert.equal(decodeText(high, label), expected, label);
  }
  assert.equal(decodeText(Buffer.from("caf\xe9 \x93ok\x94", "latin1"), "windows-1252"), "café “ok”");
  assert.equal(decodeText(Buffer.from("café"), null), "café");
  assert.equal(decodeText(Buffer.from("café"), "no-such-charset"), "café");
});

// ---- what is worth asking again -----------------------------------------------------

test("a 5xx, a 429 and a timeout are transient; any other refusal, a 404 or an unknown host, is not", async () => {
  const unavailable = web({ "https://pages.example/": { status: 503, headers: { "retry-after": "120" } } });
  await assert.rejects(safeFetch("https://pages.example/", unavailable.options()), (err: unknown) =>
    err instanceof SafeFetchError && err.transient && err.retryAfterMs === 120_000 && err.message === "The page answered 503.");
  const limited = web({ "https://pages.example/": { status: 429 } });
  await refusal(safeFetch("https://pages.example/", limited.options()), /answered 429/, true);
  const broken = web({ "https://pages.example/": { status: 500 } });
  await refusal(safeFetch("https://pages.example/", broken.options()), /answered 500/, true);
  const missing = web({ "https://pages.example/": { status: 404, headers: HTML, body: "gone" } });
  await refusal(safeFetch("https://pages.example/", missing.options()), /answered 404/, false);
  await refusal(safeFetch("https://nowhere.example/", web().options()), /No such host: nowhere\.example/, false);

  const hung = web({ "https://pages.example/": { hang: true } });
  await refusal(safeFetch("https://pages.example/", hung.options({ timeoutMs: 30 })), /didn't answer within/, true);
  const trickle = web({ "https://pages.example/": { headers: HTML, chunks: async function* () {
    yield Buffer.from("<p>first</p>");
    await new Promise(() => undefined);
  } } });
  await refusal(safeFetch("https://pages.example/", trickle.options({ timeoutMs: 30 })), /didn't answer within/, true);
});
