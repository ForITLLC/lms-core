import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as optout from "./email-optout";

// Objects built inside the vm context have its prototypes; compare them as plain data.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

type Profile = { Slug: string; CustomHostname: string | null; SupportEmail: string | null } | null;

function load(options: { profile?: Profile; sender?: { address: string; display_name: string }; env?: Record<string, string>;
  course?: unknown; send?: (input: any) => Promise<any>; logThrows?: boolean } = {}) {
  const sent: any[] = [];
  const errors: string[] = [];
  const queries: Array<{ sql: string; params: any }> = [];
  const modules: Record<string, unknown> = {
    "@/lib/vendor/mail": { createMailClient: () => ({}), sendFormToSupport: async (_client: unknown, input: any) => {
      sent.push(plain(input)); return options.send ? options.send(input) : { ok: true, sentFrom: input.from }; } },
    "@/lib/logging": { recordError: async (_service: string, message: string) => { errors.push(message); if (options.logThrows) throw new Error("log down"); } },
    "@/lib/db": { queryOne: async (sql: string, params: any) => { queries.push({ sql, params: plain(params) });
      return options.course === undefined ? { Title: "Crew Resource Management", Slug: "crm 101", LessonTitle: "Threat and error" } : options.course; } },
    "@/lib/db/tenants": { getTenantProfile: async () => options.profile === undefined
      ? { Slug: "operator", CustomHostname: "learn.operator.test", SupportEmail: "support@operator.test" } : options.profile },
    "@/lib/email-optout": optout,
    "@/lib/summary-email": { fetchSummaryMailToken: async () => "token" },
    "@/lib/tenant": { getThemeForSlug: async () => ({ email_sender: options.sender }) },
  };
  const code = ts.transpileModule(readFileSync(new URL("./support-intake.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, Error, process: { env: options.env ?? {} }, require: (id: string) => { if (!(id in modules)) throw new Error(id); return modules[id]; } });
  return { send: exports.sendFeedbackToSupport, form: exports.feedbackForm, sent, errors, queries };
}

const person = { email: "pat@operator.test", name: "Pat Example" };
const sender = { address: "learning@operator.test", display_name: "Operator Learning" };

test("course feedback opens a ticket at the tenant desk, from the tenant sender, learner as Reply-To, with rating, comment and review link", async () => {
  const app = load({ sender });
  assert.equal(await app.send("T", person, { kind: "course", courseId: "C", rating: 2, comment: "Too long" }), true);
  assert.equal(app.sent.length, 1);
  const form = app.sent[0];
  assert.equal(form.supportAddress, "support@operator.test");
  assert.equal(form.from, "learning@operator.test");
  assert.equal(form.fromName, "Operator Learning");
  assert.deepEqual(form.person, person);
  assert.equal(form.subject, "Course feedback: Crew Resource Management (2 of 5)");
  assert.deepEqual(form.fields, [
    { label: "Course", value: "Crew Resource Management" },
    { label: "Learner", value: "Pat Example <pat@operator.test>" },
    { label: "Rating", value: "2 of 5" },
    { label: "Comment", value: "Too long" },
    { label: "Review it at", value: "https://learn.operator.test/admin/courses/crm%20101" },
  ]);
  assert.deepEqual(app.queries[0]!.params, { courseId: "C" });
  assert.deepEqual(app.errors, []);
});

test("slide feedback names the lesson and looks the block up inside its course", async () => {
  const app = load({ sender });
  assert.equal(await app.send("T", person, { kind: "slide", courseId: "C", blockId: "B", comment: "Typo" }), true);
  assert.equal(app.sent[0].subject, "Slide feedback: Crew Resource Management / Threat and error");
  assert.deepEqual(app.sent[0].fields.find((field: any) => field.label === "Lesson"), { label: "Lesson", value: "Threat and error" });
  assert.deepEqual(app.queries[0]!.params, { blockId: "B", courseId: "C" });
});

test("a tenant with no sender of its own falls back to LMS_DIGEST_FROM and a host-less tenant to its learn.forit.io host", async () => {
  const app = load({ env: { LMS_DIGEST_FROM: "learning@lms.example" }, profile: { Slug: "charter", CustomHostname: null, SupportEmail: "support@charter.test" } });
  assert.equal(await app.send("T", person, { kind: "course", courseId: "C", rating: 5, comment: null }), true);
  assert.equal(app.sent[0].from, "learning@lms.example");
  assert.equal("fromName" in app.sent[0], false);
  assert.equal(app.sent[0].fields.find((field: any) => field.label === "Comment").value, "(none)");
  assert.equal(app.sent[0].fields.at(-1).value, "https://charter.learn.forit.io/admin/courses/crm%20101");
});

test("no desk, no sender, no course or a failed send is logged and never thrown", async () => {
  const feedback = { kind: "course", courseId: "C", rating: 4, comment: null };
  const cases: Array<[Parameters<typeof load>[0], RegExp]> = [
    [{ sender, profile: null }, /tenant not found or inactive/],
    [{ sender, profile: { Slug: "charter", CustomHostname: null, SupportEmail: null } }, /tenant charter has no SupportEmail/],
    [{}, /tenant operator has no sender mailbox/],
    [{ sender, course: null }, /course C not found/],
    [{ sender, send: async input => ({ ok: false, sentFrom: input.from, error: { kind: "mailbox", message: "MailboxNotEnabledForRESTAPI" } }) }, /mailbox: MailboxNotEnabledForRESTAPI/],
    [{ sender, send: async () => { throw new Error("Graph down"); } }, /Graph down/],
  ];
  for (const [options, reason] of cases) {
    const app = load(options);
    assert.equal(await app.send("T", person, feedback), false);
    assert.equal(app.errors.length, 1);
    assert.match(app.errors[0]!, reason);
    assert.match(app.errors[0]!, /^course feedback from tenant T opened no ticket: /);
  }
  assert.equal(await load({ sender, profile: null, logThrows: true }).send("T", person, feedback), false);
});
