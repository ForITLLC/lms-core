// Branded HTML and text email rendering for the public tree.

export interface InlineImageAttachment {
  contentId: string;
  contentBytes: string;
  contentType: string;
  name: string;
  isInline: true;
}

export interface BrandingOverride {
  name?: string;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  supportEmail?: string;
  supportPhone?: string;
}

interface EmailSection {
  emoji: string;
  title: string;
  content: string;
}

export interface BrandedEmailOptions {
  title: string;
  subtitle?: string;
  preheader?: string;
  sections: EmailSection[];
  footerText?: string;
  footerSubtext?: string;
}

export interface BrandIdentity {
  tenant_id: string;
  company_name: string;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  logo_url?: string;
  logo_white_url?: string;
  support_email?: string;
}

type BrandedBlock =
  | { kind: "note"; html: string }
  | { kind: "section"; label: string; icon?: string; blocks: BrandedBlock[] };

interface FooterLink {
  url: string;
  label: string;
}

export interface BrandedFooter {
  unsubscribe?: FooterLink;
  managePreferences?: FooterLink;
}

export interface BrandedDocument {
  title: string;
  subtitle?: string;
  preheader?: string;
  blocks: BrandedBlock[];
  footerNote?: string;
  footer?: BrandedFooter;
  attachments?: InlineImageAttachment[];
}

export interface RenderedBrandedEmail {
  html: string;
  attachments: InlineImageAttachment[];
}

export interface RenderedBrandedText {
  text: string;
  unsubscribe?: { url: string };
}

const CHROME = {
  page: "#f4f4f4",
  card: "#ffffff",
  border: "#dddddd",
  note: "#fafafa",
  text: "#222222",
  muted: "#666666",
  font: "Arial, Helvetica, sans-serif",
};
const LOGO_CONTENT_ID = "brand-logo";
const LOGO_WIDTH = 180;
const MAX_IMAGE_BYTES = 128 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 512 * 1024;
const CONTENT_ID = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,199}$/;
const LOGO_DATA_URI = /^data:(image\/(?:png|jpe?g|gif));base64,([A-Za-z0-9+/=]+)$/i;
const TAG = /<(\/?)([a-z][a-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</gi;
const ATTRIBUTE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SIGNATURES = new Map<string, (bytes: Buffer) => boolean>([
  ["image/png", bytes => bytes.length > 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)],
  ["image/jpeg", bytes => bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9],
  ["image/gif", bytes => bytes.length > 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))],
]);
const NAMED_ENTITIES = new Map([["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", "\""], ["apos", "'"], ["nbsp", " "]]);
const TEXT_BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "blockquote", "hr"]);
const TEXT_LINE_TAGS = new Set(["div", "tr", "li"]);
// Never "-- ": that is the signature delimiter, and clients may fold the footer under it.
const TEXT_RULE = "-".repeat(24);

function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (entity, body: string) => {
    if (!body.startsWith("#")) return NAMED_ENTITIES.get(body.toLowerCase()) ?? entity;
    const point = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff) ? String.fromCodePoint(point) : entity;
  });
}

function attributes(source: string): Array<{ name: string; value: string }> {
  return [...source.matchAll(ATTRIBUTE)].map(([, name, double, single, bare]) =>
    ({ name: (name ?? "").toLowerCase(), value: double ?? single ?? bare ?? "" }));
}

function inkOn(fill: string): string {
  const hex = fill.trim().replace(/^#/, "");
  const full = /^[0-9a-f]{3}$/i.test(hex) ? hex.replace(/./g, digit => digit + digit) : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return "#ffffff";
  const channel = (offset: number) => {
    const value = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}

// All three colours are required, secondary included, so a half-filled brand
// fails loudly instead of going out partly unbranded; none has a default.
function checkBrand(brand: BrandIdentity): void {
  for (const field of ["primary_color", "secondary_color", "accent_color"] as const) {
    const value: unknown = brand[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(`renderBranded: brand "${brand.company_name || brand.tenant_id}" has no ${field}; brand colours have no default`);
    }
  }
}

function httpsUrl(value: unknown, field: string): string {
  let url: URL | undefined;
  try {
    url = typeof value === "string" && !/[\s\u0000-\u001f\u007f<>"'\\]/.test(value) ? new URL(value) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new TypeError(`renderBranded: footer.${field}.url must be a credential-free https URL`);
  }
  return url.href;
}

type ResolvedLink = { field: keyof BrandedFooter; href: string; label: string };

function footerLinks(footer: BrandedFooter | undefined): ResolvedLink[] {
  const links: ResolvedLink[] = [];
  for (const field of ["unsubscribe", "managePreferences"] as const) {
    const link = footer?.[field];
    if (link === undefined) continue;
    if (typeof link.label !== "string" || !link.label.trim()) throw new TypeError(`renderBranded: footer.${field}.label is required`);
    links.push({ field, href: httpsUrl(link.url, field), label: link.label.trim().replace(/\s+/g, " ") });
  }
  return links;
}

function decodeBase64(value: unknown, contentId: string): Buffer {
  if (typeof value !== "string" || !value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new TypeError(`Inline image "${contentId}" needs raw base64 bytes, without a data: prefix`);
  }
  if (value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || Buffer.byteLength(value, "base64") > MAX_IMAGE_BYTES) {
    throw new RangeError(`Inline image "${contentId}" exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  return Buffer.from(value, "base64");
}

function checkImage(image: InlineImageAttachment): InlineImageAttachment {
  if (typeof image.contentId !== "string" || !CONTENT_ID.test(image.contentId)) {
    throw new TypeError("Inline image needs a contentId of letters, digits and ._@+- (without cid: or angle brackets)");
  }
  if (image.isInline !== true) throw new TypeError(`Inline image "${image.contentId}" must have isInline: true`);
  const bytes = decodeBase64(image.contentBytes, image.contentId);
  const contentType = String(image.contentType).trim().toLowerCase().replace(/^image\/jpg$/, "image/jpeg");
  if (!SIGNATURES.get(contentType)?.(bytes)) {
    throw new TypeError(`Inline image "${image.contentId}" must be PNG, JPEG or GIF bytes matching its contentType`);
  }
  const extension = contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length);
  return { contentId: image.contentId, contentBytes: image.contentBytes, contentType,
    name: image.name || `${image.contentId}.${extension}`, isInline: true };
}

function mergeImages(images: InlineImageAttachment[]): InlineImageAttachment[] {
  const byId = new Map<string, InlineImageAttachment>();
  let total = 0;
  for (const candidate of images) {
    const image = checkImage(candidate);
    const existing = byId.get(image.contentId);
    if (existing) {
      if (existing.contentBytes !== image.contentBytes || existing.contentType !== image.contentType) {
        throw new TypeError(`Two different inline images share contentId "${image.contentId}"`);
      }
      continue;
    }
    total += Buffer.byteLength(image.contentBytes, "base64");
    if (total > MAX_TOTAL_IMAGE_BYTES) throw new RangeError(`Inline images exceed ${MAX_TOTAL_IMAGE_BYTES} bytes in total`);
    byId.set(image.contentId, image);
  }
  return [...byId.values()];
}

// A logo the mail cannot carry inline (absent, remote, SVG, oversized, not the
// bytes it claims) costs the message its image, never the message itself.
function logoAttachment(brand: BrandIdentity): InlineImageAttachment | null {
  const match = LOGO_DATA_URI.exec((brand.logo_white_url ?? brand.logo_url ?? "").trim());
  if (!match) return null;
  try {
    return checkImage({ contentId: LOGO_CONTENT_ID, contentType: match[1]!, contentBytes: match[2]!, name: "", isInline: true });
  } catch {
    return null;
  }
}

function referencedImages(html: string, images: InlineImageAttachment[]): InlineImageAttachment[] {
  const known = new Set(images.map(image => image.contentId));
  const used = new Set<string>();
  for (const match of html.matchAll(TAG)) {
    const [whole, closing, name, attrs] = match;
    if (name === undefined) {
      if (whole === "<" && /^[a-z/]/i.test(html.charAt((match.index ?? 0) + 1))) throw new TypeError("renderBranded: malformed tag in email HTML");
      continue;
    }
    if (closing) continue;
    for (const attribute of attributes(attrs ?? "")) {
      if (["srcset", "background", "poster"].includes(attribute.name)) {
        throw new TypeError(`renderBranded: ${attribute.name} images are not supported; use an img with src="cid:<id>"`);
      }
      if (attribute.name !== "src") continue;
      const id = /^cid:(.+)$/i.exec(attribute.value.trim())?.[1];
      if (!id || !known.has(id)) {
        throw new TypeError(`renderBranded: email images must use src="cid:<id>" of an attached inline image, not ${attribute.value.slice(0, 48)}`);
      }
      used.add(id);
    }
  }
  return images.filter(image => used.has(image.contentId));
}


function renderBlock(block: BrandedBlock, brand: BrandIdentity): string {
  if (block.kind === "note") {
    return `<div style="margin:0 0 16px;padding:12px 14px;background-color:${CHROME.note};border-left:3px solid ${escape(brand.accent_color)};font-size:14px;line-height:1.5;color:${CHROME.text};">${block.html}</div>`;
  }
  const fill = escape(brand.primary_color);
  // The icon is markup like a note (an emoji or its HTML entity); the label is text.
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-collapse:collapse;">`
    + `<tr><td bgcolor="${fill}" style="padding:10px 14px;background-color:${fill};color:${inkOn(brand.primary_color)};font-size:15px;font-weight:bold;">${block.icon ? `${block.icon} ` : ""}${escape(block.label)}</td></tr>`
    + `<tr><td style="padding:14px 14px 0;border:1px solid ${CHROME.border};border-top:none;">${block.blocks.map(inner => renderBlock(inner, brand)).join("")}</td></tr>`
    + `</table>`;
}

export function renderBranded(brand: BrandIdentity, document: BrandedDocument): RenderedBrandedEmail {
  checkBrand(brand);
  const links = footerLinks(document.footer);
  const logo = logoAttachment(brand);
  const images = mergeImages([...(logo ? [logo] : []), ...(document.attachments ?? [])]);
  const fill = escape(brand.primary_color);
  const ink = inkOn(brand.primary_color);
  const company = escape(brand.company_name);
  const masthead = logo
    ? `<img src="cid:${LOGO_CONTENT_ID}" alt="${company}" width="${LOGO_WIDTH}" style="display:block;margin:0 auto;width:${LOGO_WIDTH}px;max-width:100%;height:auto;border:0;">`
    : `<div style="font-size:20px;font-weight:bold;color:${ink};">${company}</div>`;
  const preheader = document.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${CHROME.page};">${escape(document.preheader)}</div>`
    : "";
  const subtitle = document.subtitle
    ? `<p style="margin:6px 0 0;font-size:14px;color:${CHROME.muted};">${escape(document.subtitle)}</p>`
    : "";
  const footer = [
    company,
    brand.support_email ? escape(brand.support_email) : "",
    document.footerNote ? escape(document.footerNote) : "",
    ...links.map(link => `<a href="${escape(link.href)}" style="color:${CHROME.muted};text-decoration:underline;">${escape(link.label)}</a>`),
  ].filter(Boolean).map(line => `<p style="margin:0 0 4px;">${line}</p>`).join("");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(document.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${CHROME.page};">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${CHROME.page};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;font-family:${CHROME.font};">
<tr><td align="center" bgcolor="${fill}" style="padding:24px;background-color:${fill};border-bottom:3px solid ${escape(brand.accent_color)};">${masthead}</td></tr>
<tr><td style="padding:28px 28px 12px;background-color:${CHROME.card};border:1px solid ${CHROME.border};border-top:none;color:${CHROME.text};">
<h1 style="margin:0;font-size:22px;color:${CHROME.text};">${escape(document.title)}</h1>
${subtitle}
<div style="height:20px;"></div>
${document.blocks.map(block => renderBlock(block, brand)).join("")}
</td></tr>
<tr><td align="center" style="padding:16px 28px;font-size:12px;line-height:1.6;color:${CHROME.muted};">${footer}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { html, attachments: referencedImages(html, images) };
}

function htmlToText(html: string): string {
  const source = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");
  let out = "";
  let link: { href: string; start: number } | undefined;
  for (const [whole, closing, name, attrs, text] of source.matchAll(TAG)) {
    if (text !== undefined) {
      out += decodeEntities(text.replace(/\s+/g, " "));
      continue;
    }
    if (name === undefined) {
      out += whole;
      continue;
    }
    const tag = name.toLowerCase();
    const attribute = (wanted: string) => {
      const found = attributes(attrs ?? "").find(candidate => candidate.name === wanted);
      return found ? decodeEntities(found.value).trim() : undefined;
    };
    if (tag === "a" && !closing) {
      const href = attribute("href") ?? "";
      link = { href: /^(?:https?:|mailto:|tel:)/i.test(href) ? href : "", start: out.length };
    } else if (tag === "a") {
      const words = link ? out.slice(link.start).trim() : "";
      if (link?.href && words !== link.href && words !== link.href.replace(/^(?:mailto|tel):/i, "")) {
        out += words ? ` (${link.href})` : link.href;
      }
      link = undefined;
    } else if (tag === "img" && !closing) {
      out += attribute("alt") ?? "";
    } else if (tag === "li" && !closing) {
      out += "\n- ";
    } else if (TEXT_BLOCK_TAGS.has(tag)) {
      out += "\n\n";
    } else if (tag === "br" || (closing && TEXT_LINE_TAGS.has(tag))) {
      out += "\n";
    } else if (closing && (tag === "td" || tag === "th")) {
      out += " ";
    }
  }
  return out.split("\n").map(line => line.replace(/ {2,}/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function blockText(block: BrandedBlock): string {
  if (block.kind === "note") return htmlToText(block.html);
  return [`${block.icon ? `${block.icon} ` : ""}${block.label}`, ...block.blocks.map(blockText)].filter(part => part.trim()).join("\n\n");
}

export function renderBrandedText(brand: BrandIdentity, document: BrandedDocument): RenderedBrandedText {
  checkBrand(brand);
  const links = footerLinks(document.footer);
  const footer = [brand.company_name, brand.support_email ?? "", document.footerNote ?? "", ...links.map(link => `${link.label}: ${link.href}`)]
    .filter(line => line.trim());
  const text = [`${document.title}\n${document.subtitle ?? ""}`, ...document.blocks.map(blockText), `${TEXT_RULE}\n${footer.join("\n")}`]
    .filter(part => part.trim())
    .join("\n\n")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const unsubscribe = links.find(link => link.field === "unsubscribe");
  return { text, ...(unsubscribe ? { unsubscribe: { url: unsubscribe.href } } : {}) };
}

export async function embedLogo(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok || Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "image/png";
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}
