export * from "./mail-optout.public";

import { randomBytes } from "node:crypto";
import type { MailCategory, MailKind, OptOutStore, OptOutSubject, UnsubscribeTarget } from "./mail-optout.public";

export interface MailAttachment {
  contentId?: string;
  contentBytes: string;
  contentType: string;
  name?: string;
  isInline?: boolean;
}

export interface SendMailInput {
  from: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  replyTo?: string;
  replyToName?: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: readonly MailAttachment[];
  kind?: MailKind;
  unsubscribe?: UnsubscribeTarget;
  optOut?: { subject: OptOutSubject; category: MailCategory };
  /** Up to five custom X- headers, carried on both the JSON and the MIME path. */
  headers?: Readonly<Record<string, string>>;
}

export type MailErrorKind = "auth" | "rate_limit" | "mailbox" | "unknown";

export interface SendMailResult {
  ok: boolean;
  suppressed?: true;
  sentFrom: string;
  error?: { kind: MailErrorKind; status?: number; message: string; retryAfterMs?: number };
}

export type TokenProvider = (opts?: { forceRefresh?: boolean }) => Promise<string>;

export interface MailClientOptions {
  optOutStore?: OptOutStore;
}

export interface MailClient {
  send(input: SendMailInput): Promise<SendMailResult>;
}

export interface FormToSupportInput {
  from: string;
  fromName?: string;
  supportAddress: string;
  person?: { email?: string; name?: string };
  subject: string;
  fields: { label: string; value: string }[];
  copyTo?: string[];
}

export class MailInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailInputError";
  }
}

const GRAPH = "https://graph.microsoft.com/v1.0";
const RETRY_AFTER_CAP_MS = 30_000;
const SEND_TIMEOUT_MS = 30_000;
const MAX_MIME_BASE64 = 4 * 1024 * 1024;
const MAX_HEADER_LINE = 998;
const MAX_UNSUBSCRIBE_URI = 2048;
const WORD_BYTES = 42;
const CRLF = "\r\n";
const KINDS: readonly string[] = ["reply", "intake", "notification"];
// Graph refuses a JSON message with more than five internetMessageHeaders; Exchange owns these names.
const MAX_CUSTOM_HEADERS = 5;
const RESERVED_HEADER = /^x-(?:ms-|microsoft-|forefront-|originatororg$|msmail-priority$|priority$)/i;
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const CATEGORY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CID = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,199}$/;
const TOKEN = "[A-Za-z0-9!#$&^_.+-]+";
const MEDIA_TYPE = new RegExp(`^${TOKEN}/${TOKEN}(?:[ \\t]*;[ \\t]*${TOKEN}=${TOKEN})*$`);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAILBOX_ERROR = /mailboxnotenabledforrestapi|resource could not be discovered|errormailrecipientnotfound/i;
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };

function isPlainAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && ADDRESS.test(value);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function headerUri(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new MailInputError(`${label} is required.`);
  if (value.length > MAX_UNSUBSCRIBE_URI) throw new MailInputError(`${label} is longer than ${MAX_UNSUBSCRIBE_URI} characters.`);
  if (!/^[\x21-\x7e]+$/.test(value) || /[<>,]/.test(value)) {
    throw new MailInputError(`${label} must be printable ASCII with no space, CR, LF, "<", ">" or ",".`);
  }
  return value;
}

function validateUnsubscribe(target: UnsubscribeTarget): void {
  if (!target || typeof target !== "object") throw new MailInputError("unsubscribe must be { url, mailto? }.");
  const url = headerUri(target.url, "unsubscribe.url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MailInputError("unsubscribe.url must be an absolute https URL.");
  }
  if (!/^https:\/\//i.test(url) || parsed.protocol !== "https:" || !parsed.hostname) {
    throw new MailInputError("unsubscribe.url must be an absolute https URL.");
  }
  if (/^https:\/\/[^/?#]*@/i.test(url)) throw new MailInputError("unsubscribe.url must not carry credentials.");
  if (url.includes("#")) throw new MailInputError("unsubscribe.url must not carry a fragment.");
  if (target.mailto !== undefined && !/^mailto:./.test(headerUri(target.mailto, "unsubscribe.mailto"))) {
    throw new MailInputError("unsubscribe.mailto must start with \"mailto:\".");
  }
}

function validateOptOut(optOut: NonNullable<SendMailInput["optOut"]>): void {
  const who = optOut?.subject;
  if (!who || typeof who.tenant !== "string" || !who.tenant || typeof who.subject !== "string" || !who.subject) {
    throw new MailInputError("optOut.subject must be { tenant, subject } with both set.");
  }
  if (typeof optOut.category !== "string" || !CATEGORY.test(optOut.category)) {
    throw new MailInputError("optOut.category must be lower-case kebab-case, 1-64 characters.");
  }
}

function attachmentName(attachment: MailAttachment): string {
  return attachment.name || `${attachment.contentId || "attachment"}.bin`;
}

function normalizeAttachments(list: readonly MailAttachment[] = []): MailAttachment[] {
  const byId = new Map<string, MailAttachment>();
  const result: MailAttachment[] = [];
  for (const attachment of list) {
    const contentType = String(attachment.contentType ?? "").trim();
    if (!MEDIA_TYPE.test(contentType)) throw new MailInputError("An attachment contentType must be a media type (type/subtype).");
    const bytes = attachment.contentBytes;
    if (typeof bytes !== "string" || bytes.length % 4 !== 0 || !BASE64.test(bytes)) {
      throw new MailInputError("An attachment's contentBytes must be plain base64, not a data: URI.");
    }
    const isInline = attachment.isInline !== false;
    const id = attachment.contentId;
    if (id !== undefined && !CID.test(id)) throw new MailInputError("An attachment has an invalid contentId.");
    if (isInline && id === undefined) throw new MailInputError("An inline attachment needs the contentId its cid: reference uses.");
    const clean: MailAttachment = { ...attachment, contentType, isInline };
    if (id !== undefined) {
      const seen = byId.get(id);
      if (seen) {
        if (seen.contentBytes !== bytes || seen.contentType !== contentType || seen.name !== clean.name || seen.isInline !== isInline) {
          throw new MailInputError(`Conflicting attachments for contentId "${id}".`);
        }
        continue;
      }
      byId.set(id, clean);
    }
    result.push(clean);
  }
  return result;
}

function customHeaders(input: SendMailInput): Array<{ name: string; value: string }> {
  if (input.headers == null) return [];
  if (typeof input.headers !== "object" || Array.isArray(input.headers)) throw new MailInputError("headers must be an object of header name to value.");
  const entries = Object.entries(input.headers);
  if (entries.length > MAX_CUSTOM_HEADERS) throw new MailInputError(`A send carries at most ${MAX_CUSTOM_HEADERS} custom headers.`);
  const seen = new Set<string>();
  return entries.map(([name, value]) => {
    const label = `headers[${JSON.stringify(name.slice(0, 64))}]`;
    if (!/^[Xx]-[A-Za-z0-9][A-Za-z0-9-]*$/.test(name) || RESERVED_HEADER.test(name)) throw new MailInputError(`${label} is not an allowed X- header name.`);
    if (seen.has(name.toLowerCase())) throw new MailInputError(`${label} is given twice.`);
    seen.add(name.toLowerCase());
    if (typeof value !== "string" || !/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value) || name.length + 2 + value.length > MAX_HEADER_LINE) {
      throw new MailInputError(`${label} must be printable ASCII on one line.`);
    }
    return { name, value };
  });
}

function graphJson(input: SendMailInput, attachments: MailAttachment[]): string {
  const recipients = (list: readonly string[]) => list.map(address => ({ emailAddress: { address } }));
  const message: Record<string, unknown> = {
    subject: input.subject,
    body: { contentType: "HTML", content: input.html },
    toRecipients: recipients(input.to),
    from: { emailAddress: { address: input.from, name: input.fromName || input.from } },
  };
  if (input.cc?.length) message.ccRecipients = recipients(input.cc);
  if (input.replyTo) message.replyTo = [{ emailAddress: { address: input.replyTo, name: input.replyToName || input.replyTo } }];
  const custom = customHeaders(input);
  if (custom.length) message.internetMessageHeaders = custom;
  if (attachments.length) {
    message.attachments = attachments.map(attachment => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: attachmentName(attachment),
      contentType: attachment.contentType,
      contentBytes: attachment.contentBytes,
      ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
      isInline: attachment.isInline !== false,
    }));
  }
  return JSON.stringify({ message, saveToSentItems: true });
}

// Graph's JSON message accepts only X- headers in internetMessageHeaders, so a
// text part and List-Unsubscribe need the base64 MIME form of sendMail.
function usesMime(input: SendMailInput): boolean {
  return input.text != null || input.kind != null || input.unsubscribe != null;
}

function validateMime(input: SendMailInput): void {
  if (input.kind != null && !KINDS.includes(input.kind)) throw new MailInputError(`kind must be one of ${KINDS.join(", ")}.`);
  if (input.text != null && typeof input.text !== "string") throw new MailInputError("text must be a string.");
  if (input.unsubscribe != null) validateUnsubscribe(input.unsubscribe);
  if (input.kind !== "notification") return;
  if (!input.unsubscribe) throw new MailInputError("A notification needs unsubscribe: every notification can be stopped.");
  if (input.optOut == null) throw new MailInputError("A notification needs optOut ({ subject, category }): the switch it honours.");
  if (!Array.isArray(input.to) || input.to.length !== 1) {
    throw new MailInputError("A notification goes to exactly one recipient: its unsubscribe link is that person's.");
  }
  if (input.cc?.length) throw new MailInputError("A notification has no cc: its unsubscribe link is the recipient's.");
  const url = input.unsubscribe.url;
  if (input.text == null || !input.text.includes(url)) throw new MailInputError("A notification's text must contain unsubscribe.url.");
  if (!input.html.includes(url) && !input.html.includes(url.replace(/&/g, "&amp;"))) {
    throw new MailInputError("A notification's html must contain unsubscribe.url.");
  }
}

function noBreaks(value: string, label: string): string {
  if (/[\r\n\0]/.test(value)) throw new MailInputError(`${label} must not contain CR, LF or NUL.`);
  return value;
}

function isPlainAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value) && !value.includes("=?");
}

function encodedWords(value: string): string {
  const words: Buffer[][] = [[]];
  let size = 0;
  for (const char of value) {
    const bytes = Buffer.from(char, "utf8");
    if (size + bytes.length > WORD_BYTES) {
      words.push([]);
      size = 0;
    }
    words[words.length - 1]!.push(bytes);
    size += bytes.length;
  }
  return words.map(word => `=?UTF-8?B?${Buffer.concat(word).toString("base64")}?=`).join(`${CRLF} `);
}

function mailbox(address: unknown, name: string | undefined, label: string): string {
  if (!isPlainAddress(address)) throw new MailInputError(`${label} must be one plain address (local@domain).`);
  if (!name) return address;
  noBreaks(name, `${label} name`);
  const phrase = isPlainAscii(name) && name.length <= 200 ? `"${name.replace(/(["\\])/g, "\\$1")}"` : encodedWords(name);
  return `${phrase} <${address}>`;
}

function addressList(addresses: readonly unknown[], label: string): string {
  return addresses.map((address, i) => mailbox(address, undefined, `${label}[${i}]`)).join(`,${CRLF} `);
}

interface Part {
  headers: string[];
  body: string;
}

function base64Lines(base64: string): string {
  return (base64.match(/.{1,76}/g) ?? []).join(CRLF);
}

function textPart(subtype: "plain" | "html", content: string): Part {
  return {
    headers: [`Content-Type: text/${subtype}; charset=utf-8`, "Content-Transfer-Encoding: base64"],
    body: base64Lines(Buffer.from(content.replace(/\r\n|\r|\n/g, CRLF), "utf8").toString("base64")),
  };
}

function attachmentPart(attachment: MailAttachment): Part {
  const name = attachmentName(attachment);
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const extended = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers = [`Content-Type: ${attachment.contentType};${CRLF} name="${ascii}"`, "Content-Transfer-Encoding: base64"];
  if (attachment.contentId) headers.push(`Content-ID: <${attachment.contentId}>`);
  const disposition = attachment.isInline !== false ? "inline" : "attachment";
  headers.push(`Content-Disposition: ${disposition};${CRLF} filename="${ascii}";${CRLF} filename*=UTF-8''${extended}`);
  return { headers, body: base64Lines(attachment.contentBytes) };
}

function multipart(subtype: string, parts: Part[], extra = ""): Part {
  const rendered = parts.map(part => `${part.headers.join(CRLF)}${CRLF}${CRLF}${part.body}`);
  let boundary = "";
  do boundary = `=_${randomBytes(16).toString("hex")}`;
  while (rendered.some(text => text.includes(boundary)));
  return {
    headers: [`Content-Type: multipart/${subtype};${CRLF} boundary="${boundary}"${extra}`],
    body: `${rendered.map(text => `--${boundary}${CRLF}${text}${CRLF}`).join("")}--${boundary}--`,
  };
}

function buildMime(input: SendMailInput, attachments: MailAttachment[], now: Date): string {
  if (typeof input.subject !== "string") throw new MailInputError("subject must be a string.");
  if (!Array.isArray(input.to) || !input.to.length) throw new MailInputError("to needs at least one address.");
  const subject = noBreaks(input.subject, "subject");
  const headers = [`From: ${mailbox(input.from, input.fromName, "from")}`, `To: ${addressList(input.to, "to")}`];
  if (input.cc?.length) headers.push(`Cc: ${addressList(input.cc, "cc")}`);
  if (input.replyTo) headers.push(`Reply-To: ${mailbox(input.replyTo, input.replyToName, "replyTo")}`);
  headers.push(`Subject: ${isPlainAscii(subject) && subject.length <= 900 ? subject : encodedWords(subject)}`);
  headers.push(`Date: ${now.toUTCString().replace(/GMT$/, "+0000")}`);
  if (input.unsubscribe) {
    const { url, mailto } = input.unsubscribe;
    headers.push(`List-Unsubscribe: <${url}>${mailto ? `,${CRLF} <${mailto}>` : ""}`, "List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  }
  for (const { name, value } of customHeaders(input)) headers.push(`${name}: ${value}`);
  headers.push("MIME-Version: 1.0");
  const html = textPart("html", input.html);
  let root = input.text != null ? multipart("alternative", [textPart("plain", input.text), html]) : html;
  const rootType = input.text != null ? "multipart/alternative" : "text/html";
  const inline = attachments.filter(attachment => attachment.isInline !== false);
  const downloads = attachments.filter(attachment => attachment.isInline === false);
  if (inline.length) root = multipart("related", [root, ...inline.map(attachmentPart)], `;${CRLF} type="${rootType}"`);
  if (downloads.length) root = multipart("mixed", [root, ...downloads.map(attachmentPart)]);
  const head = [...headers, ...root.headers].join(CRLF);
  for (const line of head.split(CRLF)) {
    if (line.length > MAX_HEADER_LINE) throw new MailInputError(`A header line exceeds ${MAX_HEADER_LINE} characters.`);
  }
  return `${head}${CRLF}${CRLF}${root.body}${CRLF}`;
}

function encodeMime(message: string): string {
  const body = Buffer.from(message, "ascii").toString("base64");
  if (body.length > MAX_MIME_BASE64) throw new MailInputError(`The MIME message is ${body.length} base64 bytes, over the ${MAX_MIME_BASE64}-byte limit.`);
  return body;
}

interface GraphRequest {
  contentType: string;
  body: string;
}

function prepare(input: SendMailInput): GraphRequest {
  if (input.optOut != null) validateOptOut(input.optOut);
  if (typeof input.html !== "string") throw new MailInputError("html must be a string.");
  const attachments = normalizeAttachments(input.attachments);
  if (!usesMime(input)) return { contentType: "application/json", body: graphJson(input, attachments) };
  validateMime(input);
  return { contentType: "text/plain", body: encodeMime(buildMime(input, attachments, new Date())) };
}

async function checkOptOut(input: SendMailInput, store: OptOutStore | undefined): Promise<SendMailResult | null> {
  if (input.kind !== "notification" || !input.optOut) return null;
  let reason = "the client has no optOutStore to check the switch in";
  if (store) {
    try {
      const off: unknown = await store.isOff(input.optOut.subject, input.optOut.category);
      if (off === false) return null;
      if (off === true) return { ok: true, suppressed: true, sentFrom: input.from };
      reason = `isOff returned ${typeof off}, not a boolean`;
    } catch (error) {
      reason = reasonOf(error);
    }
  }
  return { ok: false, sentFrom: input.from, error: { kind: "unknown", message: `Opt-out check failed, so the notification was not sent: ${reason}` } };
}

function retryAfterMs(header: string | null): number {
  if (!header?.trim()) return 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? 1000 : Math.max(0, at - Date.now());
}

async function failure(response: Response): Promise<NonNullable<SendMailResult["error"]>> {
  const body = await response.text().catch(() => "");
  const status = response.status;
  const detail = body.slice(0, 300);
  if (status === 401 || status === 403) return { kind: "auth", status, message: `Graph sendMail auth failure (${status}): ${detail}` };
  if (status === 429) {
    return { kind: "rate_limit", status, message: `Graph sendMail throttled (429): ${detail}`, retryAfterMs: retryAfterMs(response.headers.get("Retry-After")) };
  }
  if (status === 404 || MAILBOX_ERROR.test(body)) return { kind: "mailbox", status, message: `Graph sendMail mailbox error (${status}): ${detail}` };
  return { kind: "unknown", status, message: `Graph sendMail failed (${status}): ${detail}` };
}

// Graph never redirects sendMail, so a redirect is a failure rather than a
// second POST of the message somewhere else; a hung request gives up in 30s.
function post(token: string, from: string, request: GraphRequest): Promise<Response> {
  return fetch(`${GRAPH}/users/${encodeURIComponent(from)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": request.contentType },
    body: request.body,
    redirect: "manual",
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
}

async function send(tokenProvider: TokenProvider, input: SendMailInput, options: MailClientOptions): Promise<SendMailResult> {
  const request = prepare(input);
  const stopped = await checkOptOut(input, options.optOutStore);
  if (stopped) return stopped;
  const sent: SendMailResult = { ok: true, sentFrom: input.from };
  let token: string;
  try {
    token = await tokenProvider();
  } catch (error) {
    return { ok: false, sentFrom: input.from, error: { kind: "auth", message: `Token acquisition failed: ${reasonOf(error)}` } };
  }
  let response = await post(token, input.from, request);
  if (response.ok) return sent;
  let error = await failure(response);
  if (response.status === 401) {
    try {
      token = await tokenProvider({ forceRefresh: true });
    } catch (refreshError) {
      return { ok: false, sentFrom: input.from, error: { kind: "auth", message: `Token refresh after 401 failed: ${reasonOf(refreshError)}` } };
    }
    response = await post(token, input.from, request);
    if (response.ok) return sent;
    error = await failure(response);
  }
  if (error.kind === "rate_limit") {
    await new Promise(resolve => setTimeout(resolve, Math.min(error.retryAfterMs ?? 1000, RETRY_AFTER_CAP_MS)));
    response = await post(token, input.from, request);
    if (response.ok) return sent;
    error = await failure(response);
  }
  return { ok: false, sentFrom: input.from, error };
}

export function createMailClient(tokenProvider: TokenProvider, options: MailClientOptions = {}): MailClient {
  return { send: input => send(tokenProvider, input, options) };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => HTML_ESCAPES[char] ?? char);
}

function oneLine(value: unknown): string {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
}

export async function sendFormToSupport(client: MailClient, input: FormToSupportInput): Promise<SendMailResult> {
  if (!isPlainAddress(input.supportAddress)) {
    throw new MailInputError("sendFormToSupport needs supportAddress (one plain address): a form always opens a ticket.");
  }
  const raw: unknown = input.person?.email;
  if (raw != null && (typeof raw !== "string" || /[\r\n]/.test(raw))) throw new MailInputError("person.email must be a single address.");
  const email = (raw as string | undefined)?.trim() || undefined;
  if (email && !isPlainAddress(email)) throw new MailInputError("person.email must be a single address.");
  if (!Array.isArray(input.fields)) throw new MailInputError("fields must be an array of { label, value }.");
  const desk = input.supportAddress.toLowerCase();
  const copyTo = [...new Set(input.copyTo ?? [])].filter(address => String(address).toLowerCase() !== desk);
  if (!copyTo.every(isPlainAddress)) throw new MailInputError("Every copyTo entry must be one plain address.");
  const subject = oneLine(input.subject);
  const name = email ? oneLine(input.person?.name) || undefined : undefined;
  const fields = input.fields.map(field => ({ label: oneLine(field.label), value: String(field.value ?? "") }));
  const cell = "style='padding:6px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;text-align:left'";
  const rows = fields
    .map(({ label, value }) => `<tr><th ${cell}>${escapeHtml(label)}</th><td ${cell}>${escapeHtml(value).replace(/\r\n|\r|\n/g, "<br>")}</td></tr>`)
    .join("");
  const html = `<h1 style='font-size:18px;margin:0 0 12px'>${escapeHtml(subject)}</h1>`
    + `<table style='border-collapse:collapse' cellpadding='0' cellspacing='0'>${rows}</table>`;
  const text = [subject, "", ...fields.map(({ label, value }) => `${label}: ${value.replace(/\r\n|\r|\n/g, "\n  ")}`)].join("\n");
  return client.send({
    from: input.from,
    ...(input.fromName ? { fromName: input.fromName } : {}),
    to: [input.supportAddress],
    ...(copyTo.length ? { cc: copyTo } : {}),
    ...(email ? { replyTo: email, ...(name ? { replyToName: name } : {}) } : {}),
    subject,
    html,
    text,
    kind: "intake",
  });
}
