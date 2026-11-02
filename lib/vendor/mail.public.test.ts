import { test } from "node:test";
import assert from "node:assert/strict";
import { createMailClient, MailInputError, sendFormToSupport, type OptOutStore, type SendMailInput } from "./mail.public";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
const PDF = Buffer.from("%PDF-1.4 example").toString("base64");
const UNSUBSCRIBE = "https://learn.example.test/api/unsubscribe?t=abc.def&x=1";
const WHO = { tenant: "tenant-a", subject: "e:hash" };

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

async function withFetch(responses: Array<() => Response>, run: (calls: Call[]) => Promise<void>): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body) });
    const next = responses.shift();
    assert.ok(next, "no fetch was expected");
    return next();
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const accepted = () => new Response(null, { status: 202 });

function tokens() {
  const requests: Array<{ forceRefresh?: boolean } | undefined> = [];
  let n = 0;
  const provider = async (opts?: { forceRefresh?: boolean }) => {
    requests.push(opts);
    n++;
    return `token-${n}`;
  };
  return { provider, requests };
}

function store(off: boolean | (() => Promise<boolean>)): OptOutStore & { asked: number } {
  const target = {
    asked: 0,
    async isOff() {
      target.asked++;
      return typeof off === "function" ? off() : off;
    },
    async setOff() {},
    async setOn() {},
    async list() {
      return [];
    },
  };
  return target;
}

interface Entity {
  headers: Map<string, string>;
  body: string;
}

function parseEntity(raw: string): Entity {
  const split = raw.indexOf("\r\n\r\n");
  assert.ok(split > 0, "entity has a header block");
  const headers = new Map<string, string>();
  for (const line of raw.slice(0, split).replace(/\r\n[ \t]/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body: raw.slice(split + 4) };
}

function partsOf(entity: Entity): Entity[] {
  const boundary = /boundary="([^"]+)"/.exec(entity.headers.get("content-type") ?? "")?.[1];
  assert.ok(boundary, "multipart has a boundary");
  const sections = entity.body.split(`--${boundary}`);
  assert.match(sections.at(-1)!, /^--/);
  return sections.slice(1, -1).map(section => parseEntity(section.replace(/^\r\n/, "").replace(/\r\n$/, "")));
}

function decoded(entity: Entity): string {
  assert.equal(entity.headers.get("content-transfer-encoding"), "base64");
  return Buffer.from(entity.body.replace(/\r\n/g, ""), "base64").toString("utf8");
}

function mimeOf(call: Call): { raw: string; message: Entity } {
  assert.equal(call.headers["Content-Type"], "text/plain");
  assert.match(call.body, /^[A-Za-z0-9+/]+=*$/);
  const raw = Buffer.from(call.body, "base64").toString("latin1");
  assert.match(raw, /^[\x00-\x7f]*$/);
  for (const line of raw.split("\r\n")) assert.ok(line.length <= 998);
  return { raw, message: parseEntity(raw) };
}

function decodeWords(value: string): string {
  return value.replace(/\?=\s+=\?/g, "?==?").replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b64: string) => Buffer.from(b64, "base64").toString("utf8"));
}

const notification = (extra: Partial<SendMailInput> = {}): SendMailInput => ({
  kind: "notification",
  from: "learning@example.test",
  fromName: "Operator Learning",
  to: ["pat@example.test"],
  subject: "Your learning summary",
  html: `<p>Hello</p><img src="cid:portrait"><a href="${UNSUBSCRIBE.replace(/&/g, "&amp;")}">Unsubscribe</a>`,
  text: `Hello\nUnsubscribe: ${UNSUBSCRIBE}`,
  attachments: [{ contentId: "portrait", contentBytes: PNG, contentType: "image/png", name: "portrait.png", isInline: true }],
  unsubscribe: { url: UNSUBSCRIBE, mailto: "mailto:unsubscribe@example.test?subject=stop" },
  optOut: { subject: WHO, category: "learning-summary" },
  ...extra,
});

test("a plain send goes to Graph as JSON with inline CID and downloadable attachments", async () => {
  await withFetch([accepted], async calls => {
    const { provider, requests } = tokens();
    const result = await createMailClient(provider).send({
      from: "sender@example.test", fromName: "Operator", to: ["a@example.test", "b@example.test"], cc: ["c@example.test"],
      replyTo: "desk@example.test", replyToName: "Desk", subject: "Learning", html: "<img src=\"cid:logo\"><p>Body</p>",
      attachments: [
        { contentId: "logo", contentBytes: PNG, contentType: "image/png", name: "logo.png", isInline: true },
        { contentId: "logo", contentBytes: PNG, contentType: "image/png", name: "logo.png", isInline: true },
        { contentBytes: PDF, contentType: "application/pdf", name: "report.pdf", isInline: false },
      ],
    });
    assert.deepEqual(result, { ok: true, sentFrom: "sender@example.test" });
    assert.deepEqual(requests, [undefined]);
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, "https://graph.microsoft.com/v1.0/users/sender%40example.test/sendMail");
    assert.equal(call.headers.Authorization, "Bearer token-1");
    assert.equal(call.headers["Content-Type"], "application/json");
    const payload = JSON.parse(call.body);
    assert.equal(payload.saveToSentItems, true);
    const message = payload.message;
    assert.equal(message.subject, "Learning");
    assert.deepEqual(message.body, { contentType: "HTML", content: "<img src=\"cid:logo\"><p>Body</p>" });
    assert.deepEqual(message.from, { emailAddress: { address: "sender@example.test", name: "Operator" } });
    assert.deepEqual(message.toRecipients.map((r: any) => r.emailAddress.address), ["a@example.test", "b@example.test"]);
    assert.deepEqual(message.ccRecipients, [{ emailAddress: { address: "c@example.test" } }]);
    assert.deepEqual(message.replyTo, [{ emailAddress: { address: "desk@example.test", name: "Desk" } }]);
    assert.equal(message.internetMessageHeaders, undefined);
    assert.deepEqual(message.attachments, [
      { "@odata.type": "#microsoft.graph.fileAttachment", name: "logo.png", contentType: "image/png", contentBytes: PNG, contentId: "logo", isInline: true },
      { "@odata.type": "#microsoft.graph.fileAttachment", name: "report.pdf", contentType: "application/pdf", contentBytes: PDF, isInline: false },
    ]);
  });
});

test("bad attachments are refused before a token or a Graph call", async () => {
  await withFetch([], async () => {
    const { provider, requests } = tokens();
    const client = createMailClient(provider);
    const base = { from: "s@example.test", to: ["a@example.test"], subject: "x", html: "<p>x</p>" };
    const cases = [
      { contentId: "logo", contentBytes: `data:image/png;base64,${PNG}`, contentType: "image/png" },
      { contentBytes: PNG, contentType: "image/png" },
      { contentId: "bad id", contentBytes: PNG, contentType: "image/png" },
      { contentId: "logo", contentBytes: PNG, contentType: "image/png\r\nX-Evil: 1" },
      { contentId: "logo", contentBytes: PNG, contentType: "image/png\r\n\r\n;a=b" },
      { contentId: "logo", contentBytes: PNG, contentType: "image/png;\u3000a=b" },
    ];
    for (const attachment of cases) await assert.rejects(client.send({ ...base, attachments: [attachment] }), MailInputError);
    await assert.rejects(client.send({ ...base, attachments: [
      { contentId: "logo", contentBytes: PNG, contentType: "image/png" },
      { contentId: "logo", contentBytes: PDF, contentType: "image/png" },
    ] }), /Conflicting attachments/);
    assert.equal(requests.length, 0);
  });
});

test("a notification goes as base64 MIME with List-Unsubscribe, a text part and its inline CID image", async () => {
  await withFetch([accepted], async calls => {
    const optOut = store(false);
    const result = await createMailClient(tokens().provider, { optOutStore: optOut }).send(notification({ replyTo: "support@example.test" }));
    assert.deepEqual(result, { ok: true, sentFrom: "learning@example.test" });
    assert.equal(optOut.asked, 1);
    const { message } = mimeOf(calls[0]!);
    const h = message.headers;
    assert.equal(h.get("from"), "\"Operator Learning\" <learning@example.test>");
    assert.equal(h.get("to"), "pat@example.test");
    assert.equal(h.get("reply-to"), "support@example.test");
    assert.equal(h.get("subject"), "Your learning summary");
    assert.match(h.get("date") ?? "", /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
    assert.equal(h.get("list-unsubscribe"), `<${UNSUBSCRIBE}>, <mailto:unsubscribe@example.test?subject=stop>`);
    assert.equal(h.get("list-unsubscribe-post"), "List-Unsubscribe=One-Click");
    assert.equal(h.get("mime-version"), "1.0");
    assert.equal(h.has("bcc"), false);
    assert.match(h.get("content-type") ?? "", /^multipart\/related; boundary="[^"]+"; type="multipart\/alternative"$/);
    const [alternative, image] = partsOf(message);
    assert.ok(alternative && image);
    assert.equal(image.headers.get("content-id"), "<portrait>");
    assert.match(image.headers.get("content-type") ?? "", /^image\/png; name="portrait.png"$/);
    assert.match(image.headers.get("content-disposition") ?? "", /^inline; filename="portrait.png"; filename\*=UTF-8''portrait.png$/);
    assert.equal(image.body.replace(/\r\n/g, ""), PNG);
    const [plain, html] = partsOf(alternative);
    assert.ok(plain && html);
    assert.equal(plain.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(decoded(plain), `Hello\r\nUnsubscribe: ${UNSUBSCRIBE}`);
    assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(decoded(html), /cid:portrait/);
  });
});

test("an unsubscribe target alone switches to MIME; downloads go in multipart/mixed", async () => {
  await withFetch([accepted], async calls => {
    await createMailClient(tokens().provider).send({
      from: "s@example.test", to: ["a@example.test"], subject: "Report", html: "<p>Attached</p>",
      unsubscribe: { url: "https://learn.example.test/u?t=1" },
      attachments: [{ contentBytes: PDF, contentType: "application/pdf", name: "Résumé (final).pdf", isInline: false }],
    });
    const { message } = mimeOf(calls[0]!);
    assert.equal(message.headers.get("list-unsubscribe"), "<https://learn.example.test/u?t=1>");
    assert.match(message.headers.get("content-type") ?? "", /^multipart\/mixed;/);
    const [html, file] = partsOf(message);
    assert.ok(html && file);
    assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(decoded(html), "<p>Attached</p>");
    assert.equal(file.headers.has("content-id"), false);
    assert.equal(file.headers.get("content-disposition"),
      "attachment; filename=\"R_sum_ (final).pdf\"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%28final%29.pdf");
    assert.equal(file.body.replace(/\r\n/g, ""), PDF);
  });
});

test("non-ASCII subjects and names are encoded words; header injection is refused", async () => {
  await withFetch([accepted], async calls => {
    const client = createMailClient(tokens().provider);
    await client.send({ from: "s@example.test", fromName: "Équipe formation", to: ["a@example.test"], subject: "Sécurité: cours terminé ✓, module trois de la série «sécurité en vol»", html: "<p>x</p>", text: "x" });
    const { message } = mimeOf(calls[0]!);
    assert.match(message.headers.get("subject") ?? "", /^(=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= ?){2,}$/);
    assert.equal(decodeWords(message.headers.get("subject") ?? ""), "Sécurité: cours terminé ✓, module trois de la série «sécurité en vol»");
    assert.equal(decodeWords(message.headers.get("from") ?? ""), "Équipe formation <s@example.test>");
    const base = { from: "s@example.test", to: ["a@example.test"], subject: "x", html: "<p>x</p>", text: "x" };
    await assert.rejects(client.send({ ...base, subject: "Hi\r\nBcc: victim@example.test" }), /subject must not contain CR, LF/);
    await assert.rejects(client.send({ ...base, fromName: "A\nB" }), /from name must not contain/);
    await assert.rejects(client.send({ ...base, replyTo: "a@example.test, b@example.test" }), /replyTo must be one plain address/);
    await assert.rejects(client.send({ ...base, to: ["a@example.test\r\nX: y"] }), /to\[0\] must be one plain address/);
    assert.equal(calls.length, 1);
  });
});

test("custom X- headers ride both paths; a reserved, malformed or sixth one is refused before a token", async () => {
  await withFetch([accepted, accepted], async calls => {
    const { provider, requests } = tokens();
    const client = createMailClient(provider, { optOutStore: store(false) });
    const headers = { "X-CodeTwoProcessed": "true", "X-Example-Run": "probe 1" };
    await client.send({ from: "s@example.test", to: ["a@example.test"], subject: "x", html: "<p>x</p>", headers });
    assert.deepEqual(JSON.parse(calls[0]!.body).message.internetMessageHeaders,
      [{ name: "X-CodeTwoProcessed", value: "true" }, { name: "X-Example-Run", value: "probe 1" }]);
    await client.send(notification({ headers }));
    const { message } = mimeOf(calls[1]!);
    assert.equal(message.headers.get("x-codetwoprocessed"), "true");
    assert.equal(message.headers.get("x-example-run"), "probe 1");
    assert.equal(message.headers.get("list-unsubscribe-post"), "List-Unsubscribe=One-Click");
    const base = { from: "s@example.test", to: ["a@example.test"], subject: "x", html: "<p>x</p>" };
    const six = Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`X-H${n}`, "1"]));
    for (const [bad, reason] of [
      [{ "Reply-To": "x@example.test" }, /not an allowed X- header name/],
      [{ "X-MS-Exchange-Organization-SCL": "-1" }, /not an allowed X- header name/],
      [{ "X-Priority": "1" }, /not an allowed X- header name/],
      [{ "X-A": "1", "x-a": "2" }, /given twice/],
      [{ "X-A": "line\r\nBcc: victim@example.test" }, /printable ASCII on one line/],
      [{ "X-A": " padded" }, /printable ASCII on one line/],
      [six, /at most 5 custom headers/],
    ] as const) await assert.rejects(client.send({ ...base, headers: bad }), reason);
    assert.equal(calls.length, 2);
    assert.equal(requests.length, 2);
  });
});

test("a notification is refused unless it carries everything its unsubscribe needs", async () => {
  await withFetch([], async () => {
    const { provider, requests } = tokens();
    const client = createMailClient(provider, { optOutStore: store(false) });
    const cases: Array<[Partial<SendMailInput>, RegExp]> = [
      [{ unsubscribe: undefined }, /needs unsubscribe/],
      [{ optOut: undefined }, /needs optOut/],
      [{ to: ["a@example.test", "b@example.test"] }, /exactly one recipient/],
      [{ cc: ["c@example.test"] }, /no cc/],
      [{ text: undefined }, /text must contain unsubscribe.url/],
      [{ text: "no link" }, /text must contain unsubscribe.url/],
      [{ html: "<p>no link</p>" }, /html must contain unsubscribe.url/],
      [{ unsubscribe: { url: "http://learn.example.test/u" } }, /absolute https URL/],
      [{ unsubscribe: { url: "https://user:pw@learn.example.test/u" } }, /credentials/],
      [{ unsubscribe: { url: "https://@learn.example.test/u" } }, /credentials/],
      [{ unsubscribe: { url: "https://learn.example.test/u#top" } }, /fragment/],
      [{ unsubscribe: { url: "https://learn.example.test/u>, <https://evil.example.test" } }, /printable ASCII/],
      [{ unsubscribe: { url: UNSUBSCRIBE, mailto: "unsubscribe@example.test" } }, /mailto must start/],
      [{ optOut: { subject: WHO, category: "Learning Summary" } }, /kebab-case/],
      [{ optOut: { subject: { tenant: "", subject: "e:x" }, category: "learning-summary" } }, /tenant, subject/],
    ];
    for (const [extra, reason] of cases) await assert.rejects(client.send(notification(extra)), reason);
    await assert.rejects(client.send({ ...notification(), kind: "bulk" as never }), /kind must be one of/);
    assert.equal(requests.length, 0);
  });
});

test("a switched-off notification is suppressed with no token and no Graph call; a store failure fails closed", async () => {
  await withFetch([], async () => {
    const { provider, requests } = tokens();
    const off = store(true);
    assert.deepEqual(await createMailClient(provider, { optOutStore: off }).send(notification()), { ok: true, suppressed: true, sentFrom: "learning@example.test" });
    assert.equal(off.asked, 1);
    const closed = [
      createMailClient(provider),
      createMailClient(provider, { optOutStore: store(async () => { throw new Error("db down"); }) }),
      createMailClient(provider, { optOutStore: store(async () => "yes" as never) }),
    ];
    const reasons = [/no optOutStore/, /db down/, /isOff returned string/];
    for (const [i, client] of closed.entries()) {
      const result = await client.send(notification());
      assert.equal(result.ok, false);
      assert.equal(result.suppressed, undefined);
      assert.equal(result.error?.kind, "unknown");
      assert.match(result.error?.message ?? "", reasons[i]!);
    }
    assert.equal(requests.length, 0);
  });
});

test("a reply or intake send never consults the opt-out store", async () => {
  await withFetch([accepted], async () => {
    const optOut = store(true);
    const result = await createMailClient(tokens().provider, { optOutStore: optOut })
      .send({ kind: "reply", from: "s@example.test", to: ["a@example.test"], subject: "Code", html: "<p>123</p>", text: "123" });
    assert.equal(result.ok, true);
    assert.equal(optOut.asked, 0);
  });
});

test("429 waits for Retry-After and retries once; a second 429 reports rate_limit with its Retry-After", async () => {
  const throttled = (after: string) => () => new Response("{\"error\":{\"code\":\"TooManyRequests\"}}", { status: 429, headers: { "Retry-After": after } });
  await withFetch([throttled("0"), accepted], async calls => {
    const result = await createMailClient(tokens().provider).send({ from: "s@example.test", to: ["a@example.test"], subject: "x", html: "<p>x</p>" });
    assert.deepEqual(result, { ok: true, sentFrom: "s@example.test" });
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.body, calls[0]!.body);
  });
  await withFetch([throttled("0"), throttled("7")], async calls => {
    const result = await createMailClient(tokens().provider).send({ from: "s@example.test", to: ["a@example.test"], subject: "x", html: "<p>x</p>" });
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, "rate_limit");
    assert.equal(result.error?.status, 429);
    assert.equal(result.error?.retryAfterMs, 7000);
    assert.match(result.error?.message ?? "", /TooManyRequests/);
    assert.equal(calls.length, 2);
  });
});

test("401 refreshes the token once; auth, mailbox and other failures are classified, not thrown", async () => {
  const input = { from: "s@example.test", to: ["a@example.test"], subject: "x", html: "<p>x</p>" };
  await withFetch([() => new Response("expired", { status: 401 }), accepted], async calls => {
    const { provider, requests } = tokens();
    assert.equal((await createMailClient(provider).send(input)).ok, true);
    assert.deepEqual(requests, [undefined, { forceRefresh: true }]);
    assert.equal(calls[1]!.headers.Authorization, "Bearer token-2");
  });
  const cases: Array<[() => Response, string, number]> = [
    [() => new Response("forbidden", { status: 403 }), "auth", 1],
    [() => new Response("{\"error\":{\"code\":\"ErrorItemNotFound\"}}", { status: 404 }), "mailbox", 1],
    [() => new Response("{\"error\":{\"code\":\"MailboxNotEnabledForRESTAPI\"}}", { status: 400 }), "mailbox", 1],
    [() => new Response("boom", { status: 500 }), "unknown", 1],
    [() => new Response(null, { status: 307, headers: { Location: "https://elsewhere.example.test/" } }), "unknown", 1],
  ];
  for (const [respond, kind, count] of cases) {
    await withFetch([respond], async calls => {
      const result = await createMailClient(tokens().provider).send(input);
      assert.equal(result.ok, false);
      assert.equal(result.error?.kind, kind);
      assert.equal(calls.length, count);
    });
  }
  await withFetch([], async () => {
    const result = await createMailClient(async () => { throw new Error("no credentials"); }).send(input);
    assert.deepEqual(result.error, { kind: "auth", message: "Token acquisition failed: no credentials" });
  });
});

test("Graph is never followed through a redirect and a hung request is given up", async () => {
  const original = globalThis.fetch;
  const seen: RequestInit[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init!);
    return accepted();
  }) as typeof fetch;
  try {
    const input = { from: "s@example.test", to: ["a@example.test"], subject: "x", html: "<p>x</p>" };
    assert.equal((await createMailClient(tokens().provider).send(input)).ok, true);
    assert.equal(seen[0]!.redirect, "manual");
    assert.ok(seen[0]!.signal instanceof AbortSignal);
  } finally {
    globalThis.fetch = original;
  }
});

test("sendFormToSupport opens a ticket at the desk with escaped fields, a text part and the person as Reply-To", async () => {
  const sent: SendMailInput[] = [];
  const client = { send: async (input: SendMailInput) => { sent.push(input); return { ok: true, sentFrom: input.from }; } };
  const result = await sendFormToSupport(client, {
    from: "learning@example.test", fromName: "Operator Learning", supportAddress: "Support@example.test",
    person: { email: " pat@example.test ", name: "Pat\r\nExample" },
    subject: "Course feedback:\n<b>Safety</b>",
    fields: [
      { label: "Learner", value: "Pat Example <pat@example.test>" },
      { label: "Comment", value: "Line one & \"two\"\nline 'three' <script>alert(1)</script>" },
    ],
    copyTo: ["support@example.test", "lead@example.test", "lead@example.test"],
  });
  assert.equal(result.ok, true);
  const input = sent[0]!;
  assert.equal(input.kind, "intake");
  assert.deepEqual(input.to, ["Support@example.test"]);
  assert.deepEqual(input.cc, ["lead@example.test"]);
  assert.equal(input.replyTo, "pat@example.test");
  assert.equal(input.replyToName, "Pat Example");
  assert.equal(input.from, "learning@example.test");
  assert.equal(input.fromName, "Operator Learning");
  assert.equal(input.subject, "Course feedback: <b>Safety</b>");
  assert.match(input.html, /<h1[^>]*>Course feedback: &lt;b&gt;Safety&lt;\/b&gt;<\/h1>/);
  assert.match(input.html, /<th[^>]*>Learner<\/th><td[^>]*>Pat Example &lt;pat@example.test&gt;<\/td>/);
  assert.ok(input.html.includes("Line one &amp; &quot;two&quot;<br>line &#39;three&#39; &lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.doesNotMatch(input.html, /<script>|<b>/);
  assert.equal(input.text, "Course feedback: <b>Safety</b>\n\nLearner: Pat Example <pat@example.test>\n"
    + "Comment: Line one & \"two\"\n  line 'three' <script>alert(1)</script>");
});

test("sendFormToSupport goes out over MIME with Reply-To, and refuses a bad desk or person address", async () => {
  await withFetch([accepted, accepted], async calls => {
    const client = createMailClient(tokens().provider);
    const form = { from: "learning@example.test", supportAddress: "support@example.test", subject: "Feedback", fields: [{ label: "Comment", value: "Fine" }] };
    assert.equal((await sendFormToSupport(client, { ...form, person: { email: "pat@example.test", name: "Pat" } })).ok, true);
    const { message } = mimeOf(calls[0]!);
    assert.equal(message.headers.get("reply-to"), "\"Pat\" <pat@example.test>");
    assert.equal(message.headers.get("to"), "support@example.test");
    assert.equal(message.headers.has("list-unsubscribe"), false);
    const [plain] = partsOf(message);
    assert.equal(decoded(plain!), "Feedback\r\n\r\nComment: Fine");
    assert.equal((await sendFormToSupport(client, { ...form, person: { name: "Anonymous" } })).ok, true);
    assert.equal(mimeOf(calls[1]!).message.headers.has("reply-to"), false);
    await assert.rejects(sendFormToSupport(client, { ...form, supportAddress: "" }), /needs supportAddress/);
    await assert.rejects(sendFormToSupport(client, { ...form, person: { email: "a@example.test, b@example.test" } }), /single address/);
    await assert.rejects(sendFormToSupport(client, { ...form, person: { email: "a@example.test\r\nBcc: b@example.test" } }), /single address/);
    await assert.rejects(sendFormToSupport(client, { ...form, copyTo: ["not an address"] }), /copyTo/);
    assert.equal(calls.length, 2);
  });
});
