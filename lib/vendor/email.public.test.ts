import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { embedLogo, renderBranded, renderBrandedText, type BrandIdentity, type BrandedDocument, type InlineImageAttachment } from "./email.public";

const pngBytes = readFileSync(new URL("../fixtures/email.png", import.meta.url));
const png = pngBytes.toString("base64");
const logo = `data:image/png;base64,${png}`;
const brand: BrandIdentity = { tenant_id: "operator", company_name: "Operator Learning", primary_color: "#234567",
  secondary_color: "#345678", accent_color: "#aabbcc", support_email: "help@example.test" };
const note = (html: string): BrandedDocument["blocks"] => [{ kind: "section", label: "Required", blocks: [{ kind: "note", html }] }];
const doc = (html = "<p>Flight safety</p>", attachments: InlineImageAttachment[] = []): BrandedDocument =>
  ({ title: "Required learning", blocks: note(html), attachments });
const image = (contentId: string, bytes = png): InlineImageAttachment =>
  ({ contentId, contentBytes: bytes, contentType: "image/png", name: `${contentId}.png`, isInline: true });
const REMOTE_OR_DATA_SRC = /src=["']?(?:data:|https?:)/i;

test("titles, labels, company name and footer text are escaped; note blocks and section icons carry their HTML", () => {
  const document: BrandedDocument = { title: "Due <soon>", subtitle: "Since <then>", preheader: "Preview <x>", footerNote: "Why <you>",
    blocks: [{ kind: "section", label: "Label <b>", icon: "&#128218;", blocks: [{ kind: "note", html: "<p><strong>Kept</strong> as HTML</p>" }] }] };
  const { html } = renderBranded({ ...brand, company_name: "Ops <&> \"Co\"", support_email: "desk<1>@example.test" }, document);
  for (const text of ["Due &lt;soon&gt;", "Since &lt;then&gt;", "Preview &lt;x&gt;", "Why &lt;you&gt;", "&#128218; Label &lt;b&gt;",
    "Ops &lt;&amp;&gt; &quot;Co&quot;", "desk&lt;1&gt;@example.test", "<p><strong>Kept</strong> as HTML</p>"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<soon>|<then>|<you>|<b>|"Co"/);
});

test("a data: URI logo becomes one inline CID attachment and the HTML references only cid:", () => {
  const rendered = renderBranded({ ...brand, logo_url: logo }, doc());
  assert.equal(rendered.attachments.length, 1);
  const [mark] = rendered.attachments;
  assert.equal(mark!.contentBytes, png);
  assert.equal(mark!.contentType, "image/png");
  assert.equal(mark!.isInline, true);
  assert.match(mark!.name, /\.png$/);
  assert.ok(rendered.html.includes(`src="cid:${mark!.contentId}"`));
  assert.doesNotMatch(rendered.html, REMOTE_OR_DATA_SRC);
  assert.ok(!rendered.html.includes(png), "logo bytes never travel in the HTML");
  const reversed = renderBranded({ ...brand, logo_url: "https://example.test/colour.png", logo_white_url: logo }, doc());
  assert.equal(reversed.attachments[0]!.contentBytes, png, "the reversed mark is used on the coloured band when present");
});

test("an unusable logo renders no image and no fallback mark, only the company name", () => {
  const oversized = Buffer.concat([pngBytes, Buffer.alloc(128 * 1024)]).toString("base64");
  for (const logo_url of [undefined, "", "https://example.test/logo.png", "http://example.test/logo.svg", "data:image/svg+xml;base64,PHN2Zy8+",
    `data:image/jpeg;base64,${png}`, `data:image/png;base64,${oversized}`, "data:image/png;base64,not base64!"]) {
    const rendered = renderBranded({ ...brand, logo_url }, doc());
    assert.equal(rendered.attachments.length, 0, String(logo_url).slice(0, 40));
    assert.doesNotMatch(rendered.html, /<img|cid:/);
    assert.match(rendered.html, />Operator Learning<\/div>/);
  }
});

test("the caller's inline attachments pass through after the logo, when the HTML references them", () => {
  const portrait = image("recipient-portrait");
  const rendered = renderBranded({ ...brand, logo_url: logo },
    doc(`<p><img src="cid:recipient-portrait" alt="Pat" width="48"/> Pat</p>`, [portrait, image("never-referenced")]));
  assert.deepEqual(rendered.attachments.at(-1), portrait);
  assert.equal(rendered.attachments.length, 2);
  for (const attachment of rendered.attachments) assert.ok(rendered.html.includes(`cid:${attachment.contentId}`));
  assert.doesNotMatch(rendered.html, REMOTE_OR_DATA_SRC);
  const withoutLogo = renderBranded(brand, doc(`<img src='cid:recipient-portrait' alt="Pat">`, [portrait]));
  assert.deepEqual(withoutLogo.attachments, [portrait]);
});

test("content images must be attached inline CIDs within the size limits", () => {
  for (const html of [`<img src="https://example.test/p.png">`, `<img alt=">" src="http://example.test/p.png">`, `<img src="data:image/png;base64,${png}">`,
    `<img src="cid:missing">`, `<td background="https://example.test/bg.png">`, `<img srcset="https://example.test/p.png 2x" src="cid:p">`, `<img src="cid:p`]) {
    assert.throws(() => renderBranded(brand, doc(html, [image("p")])), TypeError, html);
  }
  assert.throws(() => renderBranded(brand, doc("", [image("p"), image("p", Buffer.concat([pngBytes, Buffer.from([0])]).toString("base64"))])), /share contentId/);
  assert.throws(() => renderBranded(brand, doc("", [{ ...image("p"), isInline: false as unknown as true }])), /isInline/);
  assert.throws(() => renderBranded(brand, doc("", [{ ...image("p"), contentBytes: logo }])), /raw base64/);
  assert.throws(() => renderBranded(brand, doc("", [{ ...image("p"), contentType: "image/svg+xml" }])), /PNG, JPEG or GIF/);
  const large = Buffer.concat([pngBytes, Buffer.alloc(110 * 1024)]).toString("base64");
  assert.throws(() => renderBranded(brand, doc("", [image("p", Buffer.concat([pngBytes, Buffer.alloc(128 * 1024)]).toString("base64"))])), RangeError);
  assert.throws(() => renderBranded(brand, doc("", ["a", "b", "c", "d", "e"].map(id => image(id, large)))), /in total/);
});

test("a brand missing any of its three colours is refused, never defaulted", () => {
  for (const field of ["primary_color", "secondary_color", "accent_color"] as const) {
    assert.throws(() => renderBranded({ ...brand, [field]: "" }, doc()), new RegExp(`no ${field}`));
    assert.throws(() => renderBrandedText({ ...brand, [field]: " " }, doc()), new RegExp(`no ${field}`));
  }
  const pale = renderBranded({ ...brand, primary_color: "#fff8c0" }, doc()).html;
  assert.match(pale, /bgcolor="#fff8c0"/);
  assert.match(pale, /color:#000000;">Operator Learning/);
  assert.match(renderBranded(brand, doc()).html, /color:#ffffff;">Operator Learning/);
});

test("the text part says what the HTML says and ends with the footer's links; unsubscribe is the footer's href", () => {
  const document: BrandedDocument = { title: "Your learning summary", subtitle: "Updates since 2026-10-17", footerNote: "Operator Learning · daily summary",
    blocks: note(`<p>Open <a href="https://example.test/summary?a=1&amp;b=2">the summary</a></p><ul><li>One</li><li>Two &amp; three</li></ul><p><img src="cid:p" alt="Pat"> Pat</p>`),
    footer: { unsubscribe: { url: "https://example.test/api/unsubscribe?t=abc", label: "Unsubscribe from summary emails" },
      managePreferences: { url: "https://example.test/dashboard/settings", label: "Manage email settings" } },
    attachments: [image("p")] };
  const rendered = renderBrandedText(brand, document);
  for (const line of ["Your learning summary\nUpdates since 2026-10-17", "Required", "Open the summary (https://example.test/summary?a=1&b=2)", "- One", "- Two & three", "Pat Pat",
    "Operator Learning\nhelp@example.test\nOperator Learning · daily summary"]) assert.ok(rendered.text.includes(line), line);
  assert.ok(rendered.text.endsWith("Unsubscribe from summary emails: https://example.test/api/unsubscribe?t=abc\nManage email settings: https://example.test/dashboard/settings"));
  assert.doesNotMatch(rendered.text, /<|&amp;|\n-- \n/);
  assert.deepEqual(rendered.unsubscribe, { url: "https://example.test/api/unsubscribe?t=abc" });
  const html = renderBranded(brand, document).html;
  assert.ok(html.includes(`href="${rendered.unsubscribe!.url}"`));
  assert.ok(html.includes(">Unsubscribe from summary emails</a>") && html.includes(">Manage email settings</a>"));
  const plain = renderBrandedText(brand, doc());
  assert.equal("unsubscribe" in plain, false);
  assert.ok(!renderBranded(brand, doc()).html.includes("<a "));
});

test("footer links must be credential-free https and carry a label", () => {
  for (const unsubscribe of [{ url: "http://example.test/u", label: "Unsubscribe" }, { url: "javascript:alert(1)", label: "Unsubscribe" },
    { url: "https://user:pass@example.test/u", label: "Unsubscribe" }, { url: "https://example.test/u\" onclick=\"x", label: "Unsubscribe" },
    { url: "https://example.test/u", label: " " }]) {
    assert.throws(() => renderBranded(brand, { ...doc(), footer: { unsubscribe } }), TypeError);
    assert.throws(() => renderBrandedText(brand, { ...doc(), footer: { unsubscribe } }), TypeError);
  }
});

test("embedLogo fetches a logo's bytes as a data: URI, and answers null when it cannot", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(pngBytes, { headers: { "content-type": "image/png; charset=binary" } });
    const embedded = await embedLogo("https://example.test/logo.png");
    assert.equal(embedded, logo);
    assert.equal(renderBranded({ ...brand, logo_url: embedded! }, doc()).attachments[0]!.contentBytes, png);
    globalThis.fetch = async () => new Response("missing", { status: 404 });
    assert.equal(await embedLogo("https://example.test/logo.png"), null);
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal(await embedLogo("https://example.test/logo.png"), null);
    globalThis.fetch = async () => new Response(Buffer.alloc(128 * 1024 + 1), { headers: { "content-type": "image/png" } });
    assert.equal(await embedLogo("https://example.test/logo.png"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
