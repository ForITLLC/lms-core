import { checkFetchUrl, CP1252, decodeText, safeFetch, SafeFetchError, type SafeFetchOptions } from "@/lib/net/safe-fetch";
import { extractYouTube } from "./extract-youtube";
import {
  readingMinutes,
  SOURCE_REF_MAX,
  SOURCE_TEXT_MAX,
  SOURCE_TITLE_MAX,
  SourceRefusedError,
  SourceUnavailableError,
  youTubeVideoId,
  type SourceExtract,
} from "./source";

// A public web page as a course source (docs/plans/2026-10-29-ai-authoring.md,
// slice A3), fetched through lib/net/safe-fetch.ts and read as plain text. A
// YouTube address goes to the YouTube source instead.

const PAGE_TYPES = ["text/html", "text/plain"];

export interface UrlSourceDeps {
  fetch?: Pick<SafeFetchOptions, "resolve" | "transport" | "timeoutMs">;
  youtube?: (url: string) => Promise<SourceExtract>;
}

const count = (n: number) => n.toLocaleString("en-US");

function asSourceError(err: unknown): unknown {
  if (!(err instanceof SafeFetchError)) return err;
  return err.transient ? new SourceUnavailableError(err.message, err.retryAfterMs) : new SourceRefusedError(err.message);
}

// The page address as the job will fetch it. What the address alone gives
// away (scheme, port, an address written into it) is refused before the job
// is queued; the host's addresses are checked when it is fetched.
export function checkPageUrl(address: string): string {
  if (address.length > SOURCE_REF_MAX) {
    throw new SourceRefusedError(`The web address is ${count(address.length)} characters; the most is ${count(SOURCE_REF_MAX)}.`);
  }
  let href: string;
  try {
    href = checkFetchUrl(address).href;
  } catch (err) {
    throw asSourceError(err);
  }
  if (href.length > SOURCE_REF_MAX) {
    throw new SourceRefusedError(`The web address is ${count(href.length)} characters; the most is ${count(SOURCE_REF_MAX)}.`);
  }
  return href;
}

export async function extractUrl(address: string, deps: UrlSourceDeps = {}): Promise<SourceExtract> {
  if (youTubeVideoId(address)) return (deps.youtube ?? extractYouTube)(address.trim());
  const href = checkPageUrl(address);
  let page;
  try {
    page = await safeFetch(href, { accept: PAGE_TYPES, ...deps.fetch });
  } catch (err) {
    throw asSourceError(err);
  }
  const html = page.mediaType === "text/html";
  const raw = decodeText(page.body, page.charset ?? (html ? metaCharset(page.body) : null));
  const read = html ? htmlToText(raw) : { title: "", text: plainText(raw) };
  if (!read.text) throw new SourceRefusedError("The page has no readable text.");
  if (read.text.length > SOURCE_TEXT_MAX) {
    throw new SourceRefusedError(
      `The page's text is ${count(read.text.length)} characters; the most is ${count(SOURCE_TEXT_MAX)}. Paste the part the course needs instead.`,
    );
  }
  const url = new URL(page.url);
  const site = url.hostname.replace(/^www\./, "");
  const title = (read.title || `${site}${url.pathname === "/" ? "" : url.pathname}`).slice(0, SOURCE_TITLE_MAX);
  return { kind: "url", title, author: site, url: page.url, text: read.text, approxMinutes: readingMinutes(read.text) };
}

function metaCharset(body: Buffer): string | null {
  const head = body.subarray(0, 2048).toString("latin1");
  return /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i.exec(head)?.[1] ?? null;
}

// ---- HTML to text ------------------------------------------------------------

// Dropped with everything inside them. <title> is read for the title.
const SKIPPED = new Set(["script", "style", "noscript", "svg", "template", "title"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "br", "caption", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
  "hr", "legend", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "tfoot",
  "thead", "tr", "ul",
]);
const CELL = new Set(["td", "th"]);
// What may sit in <head>; anything else, or any text, ends it, as in a browser.
const HEAD = new Set(["base", "link", "meta", "noscript", "script", "style", "template", "title"]);
const TAG_NAME = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)/;

const isNameChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 58;

// Whether html has the tag name `name` (lowercase) at `at`, case-insensitively,
// ending there.
function nameAt(html: string, at: number, name: string): boolean {
  for (let k = 0; k < name.length; k++) {
    if ((html.charCodeAt(at + k) | 0x20) !== name.charCodeAt(k)) return false;
  }
  return !isNameChar(html.charCodeAt(at + name.length));
}

// Just past the '>' that ends the tag whose attributes start at `from`; a
// quoted value may hold '>'. An unclosed tag runs to the end, as in a browser.
function tagEnd(html: string, from: number): number {
  for (let j = from; j < html.length; j++) {
    const c = html[j];
    if (c === ">") return j + 1;
    if (c === '"' || c === "'") {
      const q = html.indexOf(c, j + 1);
      if (q < 0) return html.length;
      j = q;
    }
  }
  return html.length;
}

// Where the `</name` that closes an element starting at `from` is, or the end.
function closeAt(html: string, from: number, name: string): number {
  for (let k = html.indexOf("</", from); k >= 0; k = html.indexOf("</", k + 2)) {
    if (nameAt(html, k + 2, name)) return k;
  }
  return html.length;
}

// One pass, left to right, so the work grows with the page and no crafted
// markup can make it backtrack.
export function htmlToText(html: string): { title: string; text: string } {
  const parts: string[] = [];
  let title: string | null = null;
  let inHead = false;
  // Inside <pre> the line breaks are the text's own.
  let pre = 0;
  const words = (raw: string) => {
    if (inHead && /\S/.test(raw)) inHead = false;
    if (inHead) return;
    const text = decodeEntities(raw);
    parts.push(pre > 0 ? text.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ") : text.replace(/\s+/g, " "));
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      words(html.slice(i));
      break;
    }
    words(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const next = html[lt + 1];
    if (next === "!" || next === "?") {
      const end = html.indexOf(">", lt + 2);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const tag = TAG_NAME.exec(html.slice(lt, lt + 64));
    if (!tag) {
      words("<");
      i = lt + 1;
      continue;
    }
    const closing = tag[1] === "/";
    const name = tag[2]!.toLowerCase();
    i = tagEnd(html, lt + tag[0].length);
    const selfClosed = name === "svg" && html[i - 2] === "/";
    if (!closing && SKIPPED.has(name) && !selfClosed) {
      const end = closeAt(html, i, name);
      if (name === "title" && title === null) title = html.slice(i, end);
      i = end >= html.length ? html.length : tagEnd(html, end + 2 + name.length);
      parts.push(" ");
      continue;
    }
    if (name === "head") {
      inHead = !closing;
      continue;
    }
    if (name === "body" || !HEAD.has(name)) inHead = false;
    if (inHead) continue;
    if (name === "pre") pre = closing ? Math.max(0, pre - 1) : pre + 1;
    parts.push(BLOCK.has(name) ? "\n" : CELL.has(name) ? " " : "");
  }
  return {
    title: decodeEntities(title ?? "").replace(/\s+/g, " ").trim(),
    text: lines(parts.join("")),
  };
}

function lines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function plainText(text: string): string {
  return lines(text.replace(/\r\n?/g, "\n"));
}

// ---- entities ----------------------------------------------------------------

// U+00A0 to U+00FF in order, then the rest of HTML 4's named entities that
// pages commonly use. An unknown name is left as written.
const LATIN1 = (
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute " +
  "micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig " +
  "Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash " +
  "Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc " +
  "euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml " +
  "yacute thorn yuml"
).split(" ");
const GREEK_UPPER = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho".split(" ");
const GREEK_LOWER = (
  "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon " +
  "phi chi psi omega"
).split(" ");

const NAMED: Record<string, number> = {
  quot: 34, amp: 38, apos: 39, lt: 60, gt: 62,
  OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732,
  Sigma: 931, Tau: 932, Upsilon: 933, Phi: 934, Chi: 935, Psi: 936, Omega: 937,
  ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212,
  lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225,
  bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250, oline: 8254,
  frasl: 8260, euro: 8364, trade: 8482, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, minus: 8722,
  lowast: 8727, radic: 8730, infin: 8734, asymp: 8776, ne: 8800, equiv: 8801, le: 8804, ge: 8805,
};
LATIN1.forEach((name, i) => { NAMED[name] = 160 + i; });
GREEK_UPPER.forEach((name, i) => { NAMED[name] = 913 + i; });
GREEK_LOWER.forEach((name, i) => { NAMED[name] = 945 + i; });

// Numeric references to 0x80-0x9F mean Windows-1252, as browsers read them.
function fromCode(code: number): string {
  if (code >= 0x80 && code <= 0x9f) return String.fromCodePoint(CP1252[code - 0x80]!);
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
  return String.fromCodePoint(code);
}

export function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([A-Za-z][A-Za-z0-9]{1,31});)/g,
    (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (dec) return fromCode(Number(dec));
      if (hex) return fromCode(parseInt(hex, 16));
      const code = name ? NAMED[name] : undefined;
      return code === undefined ? whole : String.fromCodePoint(code);
    },
  );
}
