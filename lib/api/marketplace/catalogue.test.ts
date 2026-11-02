import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { authConfig } from "@/lib/auth-config";
import type { MaterializedBlock } from "@/lib/db/courses";
import type { CatalogueCourseRow, ListableCourse, MarketplacePublisher } from "@/lib/db/marketplace-catalogue";
import { stripBlock } from "@/lib/mobile/course";
import { FORIT_ENTRA_TENANT_ID, requireMarketplaceCaller, type MarketplaceCallerGate } from "./auth";
import {
  createCatalogueCourseHandler,
  createCatalogueListHandler,
  recurrenceMonths,
  toCatalogueCourse,
  toCatalogueItem,
  type CatalogueCourseDeps,
  type CatalogueListDeps,
} from "./catalogue";
import { marketplaceError } from "./errors";

const COURSE = "8D0C1E2A-1111-4AAA-8BBB-000000000001";
const VERSION = "41B2C3D4-2222-4AAA-8BBB-000000000002";
const OTHER_VERSION = "41b2c3d4-2222-4aaa-8bbb-000000000099";
const PUBLISHER: MarketplacePublisher = { TenantId: "T-ACME", Slug: "acme-training", Name: "Acme Training" };
const ROOT = new URL("../../../", import.meta.url);

const row: CatalogueCourseRow = {
  CourseId: COURSE,
  Slug: "dangerous-goods-air",
  VersionId: VERSION,
  VersionNumber: 3,
  Title: "Dangerous Goods: Air (TDG 6.5)",
  Description: "Classes, labels and documents.",
  Category: "Dangerous goods",
  Tags: ["TDG 6.5 air"],
  EstMinutes: 240,
  ScheduleKind: "recurring",
  RecurrenceMonths: 24,
};

const quiz: MaterializedBlock = {
  kind: "quiz",
  blockId: "B-QUIZ",
  quizId: "Q1",
  questions: [
    { kind: "mcq", promptMd: "Class 3?", choices: [{ id: "a", label: "Flammable liquid" }, { id: "b", label: "Gas" }], correctChoiceId: "a" },
    { kind: "multi", promptMd: "Pick all", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctChoiceIds: ["a", "b"] },
    { kind: "tf", promptMd: "Lithium is class 9", correctValue: true },
    { kind: "short", promptMd: "Explain UN numbers", rubricMd: "ANSWER-KEY mentions four digits", maxScore: 5 },
    { kind: "confidence", promptMd: "Sure?", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctChoiceId: "b" },
  ],
};

const firstLessonBlocks: MaterializedBlock[] = [
  { kind: "text", blockId: "B-TEXT", markdown: "# Classes and labels" },
  quiz,
  { kind: "roleplay", blockId: "B-ROLE", persona: "Shipper", scenario: "Undeclared DG", rubricMd: "ROLEPLAY-RUBRIC" },
];

const course: ListableCourse = {
  row,
  lessons: [
    { LessonId: "L-TWO", Title: "Documents", OrderIndex: 2, EstMinutes: null, blocks: [{ kind: "text", blockId: "B-LATER", markdown: "NOT-IN-PREVIEW" }] },
    { LessonId: "L-ONE", Title: "Classes and labels", OrderIndex: 1, EstMinutes: 30, blocks: firstLessonBlocks },
  ],
};

const KEY_FIELDS = ["correctChoiceId", "correctChoiceIds", "correctValue", "rubricMd", "ANSWER-KEY", "ROLEPLAY-RUBRIC"];

test("a catalogue row maps to the §4 list item, ids lowercased, at the row's version", () => {
  assert.deepEqual(toCatalogueItem(PUBLISHER, row), {
    courseId: COURSE.toLowerCase(),
    versionId: VERSION.toLowerCase(),
    versionNumber: 3,
    publisher: { tenantSlug: "acme-training", name: "Acme Training" },
    title: "Dangerous Goods: Air (TDG 6.5)",
    description: "Classes, labels and documents.",
    category: "Dangerous goods",
    tags: ["TDG 6.5 air"],
    estMinutes: 240,
    recurrenceMonths: 24,
  });
  assert.equal(toCatalogueItem(PUBLISHER, { ...row, EstMinutes: null }).estMinutes, null);
});

test("recurrenceMonths follows the certificate expiry rule in lib/db/schedule.ts", () => {
  assert.equal(recurrenceMonths("recurring", 24), 24);
  assert.equal(recurrenceMonths("annual", null), 12);
  assert.equal(recurrenceMonths("annual", 36), 12);
  assert.equal(recurrenceMonths(null, 24), null, "no ScheduleKind is evergreen, as computeCertExpiresAt treats it");
  assert.equal(recurrenceMonths(null, null), null);
  assert.equal(recurrenceMonths("recurring", null), null);
  assert.equal(recurrenceMonths("recurring", 0), null);
});

test("the full shape has an ordered outline and previews the first lesson only", () => {
  const full = toCatalogueCourse(PUBLISHER, course);
  const { outline, preview, ...item } = full;
  assert.deepEqual(item, toCatalogueItem(PUBLISHER, row));
  assert.deepEqual(outline, [
    { lessonId: "l-one", title: "Classes and labels", estMinutes: 30 },
    { lessonId: "l-two", title: "Documents", estMinutes: null },
  ]);
  assert.ok(preview);
  assert.equal(preview.lessonId, "l-one");
  assert.equal(preview.title, "Classes and labels");
  assert.deepEqual(Object.keys(full).sort(), [
    "category", "courseId", "description", "estMinutes", "outline", "preview", "publisher",
    "recurrenceMonths", "tags", "title", "versionId", "versionNumber",
  ]);
  assert.ok(!JSON.stringify(full).includes("NOT-IN-PREVIEW"), "a later lesson's blocks left the LMS");
});

test("preview blocks are the player's stripBlock shape and carry no answer key or rubric", () => {
  const { preview } = toCatalogueCourse(PUBLISHER, course);
  assert.ok(preview);
  assert.deepEqual(preview.blocks, firstLessonBlocks.map(stripBlock));
  const json = JSON.stringify(toCatalogueCourse(PUBLISHER, course));
  for (const field of KEY_FIELDS) assert.equal(json.includes(field), false, `${field} left the LMS`);
  const shown = preview.blocks.find((b) => b.kind === "quiz");
  assert.ok(shown && shown.kind === "quiz");
  assert.deepEqual(shown.questions.map((q) => q.kind), ["mcq", "multi", "tf", "short", "confidence"]);
});

test("a version with no lessons has an empty outline and no preview", () => {
  const full = toCatalogueCourse(PUBLISHER, { row, lessons: [] });
  assert.deepEqual(full.outline, []);
  assert.equal(full.preview, null);
});

// ---- route decisions -------------------------------------------------------

const allow = async (): Promise<MarketplaceCallerGate> => ({ ok: true, caller: { appId: "MKT", roles: ["Marketplace.Catalogue.Read"] } });
const refuse = (status: 401 | 403) => async (): Promise<MarketplaceCallerGate> => ({
  ok: false,
  response: marketplaceError(status, status === 401 ? "invalid_token" : "insufficient_scope", "refused"),
});
const untouched = () => {
  throw new Error("data access before the caller was checked");
};

function listHandler(over: Partial<CatalogueListDeps> = {}) {
  const calls: { slugs: string[]; tenants: string[] } = { slugs: [], tenants: [] };
  const handler = createCatalogueListHandler({
    authenticate: allow,
    resolvePublisher: async (slug) => {
      calls.slugs.push(slug);
      return slug === PUBLISHER.Slug ? PUBLISHER : null;
    },
    listCourses: async (tenantId) => {
      calls.tenants.push(tenantId);
      return [row];
    },
    ...over,
  });
  return { handler, calls };
}

function courseHandler(over: Partial<CatalogueCourseDeps> = {}) {
  const calls: Array<[string, string, string | null]> = [];
  const handler = createCatalogueCourseHandler({
    authenticate: allow,
    findCoursePublisher: async (courseId) => (courseId.toLowerCase() === COURSE.toLowerCase() ? PUBLISHER : null),
    getCourse: async (tenantId, courseId, versionId) => {
      calls.push([tenantId, courseId, versionId]);
      return versionId === null || versionId.toLowerCase() === VERSION.toLowerCase() ? course : null;
    },
    ...over,
  });
  const get = (courseId: string, search = "") =>
    handler(new Request(`https://learn.forit.io/api/v1/marketplace/catalogue/courses/${courseId}${search}`), {
      params: Promise.resolve({ courseId }),
    });
  return { get, calls };
}

const listUrl = (search: string) => new Request(`https://learn.forit.io/api/v1/marketplace/catalogue/courses${search}`);

async function assertError(res: Response, status: number, code: string, label = code) {
  assert.equal(res.status, status, label);
  const body = await res.json();
  assert.equal(body.error, code, label);
  assert.equal(typeof body.error_description, "string", label);
  return body;
}

test("list: an auth refusal passes through untouched, before the query is read", async () => {
  for (const status of [401, 403] as const) {
    const gate = await refuse(status)();
    const { handler } = listHandler({ authenticate: async () => gate, resolvePublisher: untouched, listCourses: untouched });
    const res = await handler(listUrl(""));
    assert.ok(!gate.ok && res === gate.response, "the gate's own response");
    await assertError(res, status, status === 401 ? "invalid_token" : "insufficient_scope");
  }
});

test("list: a missing, repeated or malformed publisher is 400 invalid_request", async () => {
  const { handler, calls } = listHandler();
  for (const search of ["", "?publisher=", "?publisher=acme-training&publisher=charter", "?publisher=Acme", "?publisher=-acme",
    "?publisher=acme_training", "?publisher=acme%27%20OR%201%3D1", `?publisher=${"a".repeat(65)}`]) {
    await assertError(await handler(listUrl(search)), 400, "invalid_request", search);
  }
  assert.deepEqual(calls.slugs, []);
});

test("list: an unknown slug or a non-publisher tenant is 404 tenant_not_found", async () => {
  const { handler, calls } = listHandler();
  await assertError(await handler(listUrl("?publisher=charter")), 404, "tenant_not_found");
  assert.deepEqual(calls, { slugs: ["charter"], tenants: [] });
});

test("list: a publisher's courses come back in the {courses} wrapper, read by its TenantId", async () => {
  const { handler, calls } = listHandler();
  const res = await handler(listUrl("?publisher=acme-training"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { courses: [toCatalogueItem(PUBLISHER, row)] });
  assert.deepEqual(calls.tenants, ["T-ACME"]);
});

test("detail: an auth refusal passes through even for a malformed id", async () => {
  for (const status of [401, 403] as const) {
    const gate = await refuse(status)();
    const { get } = courseHandler({ authenticate: async () => gate, findCoursePublisher: untouched, getCourse: untouched });
    const res = await get("not-a-uuid");
    assert.ok(!gate.ok && res === gate.response, "the gate's own response");
    await assertError(res, status, status === 401 ? "invalid_token" : "insufficient_scope");
  }
});

test("detail: a courseId or versionId that is not a uuid is 400 invalid_request", async () => {
  const { get, calls } = courseHandler();
  for (const [id, search] of [["not-a-uuid", ""], [`{${COURSE}}`, ""], [`${COURSE}x`, ""], [COURSE, "?versionId=41b2"],
    [COURSE, `?versionId=${VERSION}&versionId=${VERSION}`], [COURSE, "?versionId=%27%3B--"]] as const) {
    await assertError(await get(id, search), 400, "invalid_request", `${id}${search}`);
  }
  assert.deepEqual(calls, []);
});

test("detail: unknown, unlisted or wrong-version courses are all 404 course_not_found", async () => {
  const { get, calls } = courseHandler();
  await assertError(await get("00000000-0000-4000-8000-000000000000"), 404, "course_not_found", "unknown or non-publisher course");
  assert.deepEqual(calls, []);
  await assertError(await get(COURSE, `?versionId=${OTHER_VERSION}`), 404, "course_not_found", "not a version of this course");
  const unlisted = courseHandler({ getCourse: async () => null });
  await assertError(await unlisted.get(COURSE), 404, "course_not_found", "not listable");
});

test("detail: the course is read under its publisher's TenantId, at the current version unless one is named", async () => {
  const { get, calls } = courseHandler();
  const current = await get(COURSE);
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), JSON.parse(JSON.stringify(toCatalogueCourse(PUBLISHER, course))));
  assert.equal((await get(COURSE, "?versionId=")).status, 200);
  assert.equal((await get(COURSE, `?versionId=${VERSION.toLowerCase()}`)).status, 200);
  assert.deepEqual(calls, [
    ["T-ACME", COURSE, null],
    ["T-ACME", COURSE, null],
    ["T-ACME", COURSE, VERSION.toLowerCase()],
  ]);
});

test("detail and list: a tenant lms_ key, or a token without Catalogue.Read, is refused by the real gate", async () => {
  const CLIENT = "11111111-1111-1111-1111-111111111111";
  const CALLER = "22222222-2222-2222-2222-222222222222";
  const now = new Date("2026-10-28T12:00:00Z");
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${b64({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64({
    aud: CLIENT, iss: `https://sts.windows.net/${FORIT_ENTRA_TENANT_ID}/`, exp: now.getTime() / 1000 + 3600,
    tid: FORIT_ENTRA_TENANT_ID, appid: CALLER, idtyp: "app", roles: ["Marketplace.Entitlements.Write"],
  })}`;
  const writeOnly = `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
  const authenticate = (req: Request) =>
    requireMarketplaceCaller(req, "Marketplace.Catalogue.Read", {
      env: { AZURE_AD_CLIENT_ID: CLIENT, MARKETPLACE_CALLER_APP_ID: CALLER },
      fetchJwks: async () => ({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" }] }),
      now: () => now,
    });
  const list = createCatalogueListHandler({ authenticate, resolvePublisher: untouched, listCourses: untouched });
  const detail = createCatalogueCourseHandler({ authenticate, findCoursePublisher: untouched, getCourse: untouched });
  const req = (authorization: string, path = "?publisher=acme-training") =>
    new Request(`https://learn.forit.io/api/v1/marketplace/catalogue/courses${path}`, { headers: { authorization } });
  const params = { params: Promise.resolve({ courseId: COURSE }) };

  await assertError(await list(req("Bearer lms_abc_def")), 401, "invalid_token", "list, lms_ key");
  await assertError(await detail(req("Bearer lms_abc_def", `/${COURSE}`), params), 401, "invalid_token", "detail, lms_ key");
  await assertError(await list(req(`Bearer ${writeOnly}`)), 403, "insufficient_scope", "list, write role only");
  await assertError(await detail(req(`Bearer ${writeOnly}`, `/${COURSE}`), params), 403, "insufficient_scope", "detail, write role only");
});

// ---- plumbing --------------------------------------------------------------

const source = (path: string) => readFileSync(new URL(path, ROOT), "utf8");
const ROUTES = {
  list: "app/api/v1/marketplace/catalogue/courses/route.ts",
  detail: "app/api/v1/marketplace/catalogue/courses/[courseId]/route.ts",
};

test("both routes are logged by withApiLogging and gated on Marketplace.Catalogue.Read", () => {
  for (const [name, path] of Object.entries(ROUTES)) {
    const route = source(path);
    assert.match(route, /export const GET = withApiLogging\("marketplace_\w+", createCatalogue(List|Course)Handler\(\{/, name);
    assert.match(route, /authenticate: \(req\) => requireMarketplaceCaller\(req, "Marketplace\.Catalogue\.Read"\)/, name);
    assert.doesNotMatch(route, /requireApiKey|lib\/api\/bearer/, `${name} must not accept a tenant key`);
  }
});

test("marketplace routes need no cookie session and stay out of /api/openapi.json", () => {
  // @foritllc/auth routeAccess: staffPaths win over publicPaths, which win over protectedPaths,
  // each matched on a path-segment boundary.
  const on = (paths: string[] | undefined, path: string) => (paths ?? []).some((p) => path === p || path.startsWith(`${p}/`));
  for (const path of ["/api/v1/marketplace/catalogue/courses", `/api/v1/marketplace/catalogue/courses/${COURSE}`]) {
    assert.ok(on(authConfig.publicPaths, path), path);
    assert.ok(!on(authConfig.staffPaths, path), path);
  }
  assert.doesNotMatch(source("app/api/openapi.json/route.ts"), /marketplace/i);
});
