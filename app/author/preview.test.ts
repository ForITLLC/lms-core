import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CoursePlayer from "@/components/CoursePlayer";
import PreviewPlayer from "@/components/author/PreviewPlayer";
import { GONE_DRAFT, GONE_VERSION, MISSING_QUIZ, PreviewCompletionRefused, previewEffects, STALE_DRAFT } from "@/components/author/preview-effects";
import { learnerEffects } from "@/components/player-effects";
import { buildPreview, type PreviewTarget } from "@/lib/builder/preview";
import { RoleplayBlock } from "@/lib/schema/blocks";
import { DraftDoc, DraftQuizBlock } from "@/lib/schema/draft";
import { QuizQuestion } from "@/lib/schema/quiz";

// S5 acceptance (docs/plans/2026-10-28-course-builder-mvp.md): the author
// preview's HTML, and the props the page serializes to the browser, hold no
// answer key, and the preview player writes no learner state.

// tsx compiles JSX with the classic runtime here (tsconfig says "preserve"), so
// the components look React up globally.
(globalThis as { React?: typeof React }).React = React;

const COURSE = "dddddddd-0000-0000-0000-00000000000c";
const DRAFT = "dddddddd-0000-0000-0000-00000000000d";
const TARGET: PreviewTarget = { draftId: DRAFT, revision: 7 };

// What a learner is shown of a question, a quiz block and a role-play. Every
// other field the schemas define is forbidden, so a field added to the quiz
// schema later is caught here until someone decides a learner may see it.
const SHOWN = new Set(["kind", "promptMd", "choices", "maxScore", "questions", "persona", "scenario", "key"]);
const schemaFields = [
  ...QuizQuestion.options.flatMap((option) => Object.keys(option.shape)),
  ...Object.keys(DraftQuizBlock.shape),
  ...Object.keys(RoleplayBlock.shape),
];
const FORBIDDEN = [...new Set(schemaFields.filter((field) => !SHOWN.has(field)))];
const SECRETS = ["RUBRIC-SHORT-7f3a", "RUBRIC-ROLEPLAY-91c2"];

const question = {
  mcq: { kind: "mcq", promptMd: "PROMPT-mcq", choices: [{ id: "a", label: "Chocks" }, { id: "b", label: "Cones" }], correctChoiceId: "b" },
  multi: { kind: "multi", promptMd: "PROMPT-multi", choices: [{ id: "a", label: "Fuel" }, { id: "b", label: "Oil" }, { id: "c", label: "Water" }], correctChoiceIds: ["a", "c"] },
  tf: { kind: "tf", promptMd: "PROMPT-tf", correctValue: false },
  short: { kind: "short", promptMd: "PROMPT-short", rubricMd: SECRETS[0], maxScore: 4 },
  confidence: { kind: "confidence", promptMd: "PROMPT-confidence", choices: [{ id: "x", label: "Left" }, { id: "y", label: "Right" }], correctChoiceId: "y" },
};

// One quiz block per question kind, so each one is the first slide of a
// render below, plus one quiz holding them all.
const doc = DraftDoc.parse({
  meta: { title: "Ramp safety", requiresQuizPass: true },
  lessons: [
    {
      key: "l1",
      title: "Walkaround",
      blocks: [
        { kind: "text", key: "t1", markdown: "Walk the ramp" },
        ...Object.entries(question).map(([kind, q]) => ({ kind: "quiz", key: `q-${kind}`, passingScore: 80, questions: [q] })),
        { kind: "quiz", key: "q-all", passingScore: 60, questions: Object.values(question) },
      ],
    },
    {
      key: "l2",
      title: "Fuelling",
      blocks: [
        { kind: "roleplay", key: "rp", persona: "Captain", scenario: "Late fuel", rubricMd: SECRETS[1] },
        { kind: "package", key: "pkg", launchableId: "dddddddd-0000-0000-0000-000000000009", title: "Ramp sim", standard: "scorm12" },
      ],
    },
  ],
});

const preview = buildPreview({ courseId: COURSE, slug: "ramp-safety" }, doc);
const pageProps = { courseId: COURSE, target: TARGET, preview };

function scan(label: string, text: string) {
  for (const field of FORBIDDEN) assert.equal(text.includes(field), false, `${label} contains ${field}`);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${label} contains ${secret}`);
}

// Every slide that has a block, rendered as the player's first slide: the
// player resumes at the first block not yet seen.
function everySlide(effects: ReturnType<typeof previewEffects>): string[] {
  const blockIds = preview.lessons.flatMap((l) => l.blocks.filter((b) => b.kind !== "roleplay").map((b) => b.blockId));
  return blockIds.map((_, i) =>
    renderToStaticMarkup(
      React.createElement(CoursePlayer, { course: preview.course, lessons: preview.lessons, completedBlockIds: blockIds.slice(0, i), effects }),
    ),
  );
}

test("the forbidden list comes from the schemas and the draft itself holds every entry (known positive)", () => {
  for (const field of ["correctChoiceId", "correctChoiceIds", "correctValue", "rubricMd", "passingScore"]) assert.ok(FORBIDDEN.includes(field), field);
  const raw = JSON.stringify(doc);
  for (const field of FORBIDDEN) assert.ok(raw.includes(`"${field}"`), `the fixture draft carries ${field}`);
  for (const secret of SECRETS) assert.ok(raw.includes(secret), secret);
  assert.deepEqual([...new Set(doc.lessons.flatMap((l) => l.blocks.flatMap((b) => (b.kind === "quiz" ? b.questions.map((q) => q.kind) : []))))].sort(), [...QuizQuestion.options.map((o) => o.shape.kind.value)].sort());
});

test("the preview HTML and the props sent to the browser contain no correctChoiceId or any other answer key", () => {
  scan("serialized page props", JSON.stringify(pageProps));

  const page = renderToStaticMarkup(React.createElement(PreviewPlayer, pageProps));
  assert.ok(page.includes("Preview — progress isn’t saved."), "the preview bar is shown");
  assert.ok(page.includes(`href="/author/courses/${COURSE}"`), "the preview links back to the editor");
  assert.ok(page.includes("revision 7"));
  scan("preview page HTML", page);

  const slides = everySlide(previewEffects({ courseId: COURSE, target: TARGET, quizKeys: preview.quizKeys, requiresQuizPass: true, packageBlocks: preview.packageBlocks }));
  for (const kind of Object.keys(question)) assert.ok(slides.some((html) => html.includes(`PROMPT-${kind}`)), `the ${kind} question rendered`);
  assert.ok(slides.some((html) => html.includes("Ramp sim") && html.includes("Activity")), "the package block renders as PackageNotice");
  slides.forEach((html, i) => scan(`slide ${i + 1} HTML`, html));
});

test("the preview player shows no feedback forms and leads out to the editor; the learner player still does both its own way", () => {
  const previewHtml = renderToStaticMarkup(React.createElement(PreviewPlayer, pageProps));
  assert.ok(!previewHtml.includes("Feedback on this slide"));
  assert.ok(!previewHtml.includes('href="/learn"'));
  const learnerHtml = renderToStaticMarkup(React.createElement(CoursePlayer, { course: preview.course, lessons: preview.lessons }));
  assert.ok(learnerHtml.includes("Feedback on this slide"), "known positive: the learner player offers feedback");
  assert.ok(learnerHtml.includes('href="/learn"'));
});

function recordingFetch(status = 200, body: unknown = { score: 100, passed: true, passingScore: 80, correctCount: 1, autoGradableCount: 1, perQuestion: [{ orderIndex: 0, correct: true }] }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test("preview effects grade through the author grade route and write nothing else", async () => {
  const { fetcher, calls } = recordingFetch();
  const effects = previewEffects({ courseId: COURSE, target: TARGET, quizKeys: preview.quizKeys, requiresQuizPass: true, packageBlocks: preview.packageBlocks, fetcher });
  const quiz = preview.lessons[0]!.blocks[1]!;
  assert.equal(quiz.kind, "quiz");
  if (quiz.kind !== "quiz") return;

  const result = await effects.submitQuiz(quiz.quizId, ["b"]);
  assert.equal(result.score, 100);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `/api/author/courses/${COURSE}/draft/grade`);
  assert.equal(calls[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { draftId: DRAFT, revision: 7, blockKey: "q-mcq", responses: ["b"] });

  await effects.recordSeen(quiz.blockId);
  await assert.rejects(
    effects.complete(),
    (error: unknown) => error instanceof PreviewCompletionRefused && error.refusal.code === "quiz_submission_required",
    "quizzes not yet submitted refuse completion, as for a learner",
  );
  assert.equal(calls.length, 1, "seen and complete send nothing");
  assert.equal(effects.feedback, false);
  await assert.rejects(effects.submitQuiz("not-a-preview-quiz", ["b"]));
  assert.equal(calls.length, 1);

  const published = recordingFetch();
  await previewEffects({ courseId: COURSE, target: { draftId: null, versionId: "dddddddd-0000-0000-0000-0000000000aa" }, quizKeys: preview.quizKeys, requiresQuizPass: false, packageBlocks: preview.packageBlocks, fetcher: published.fetcher }).submitQuiz(quiz.quizId, ["a"]);
  assert.deepEqual(JSON.parse(String(published.calls[0]!.init.body)), { draftId: null, versionId: "dddddddd-0000-0000-0000-0000000000aa", blockKey: "q-mcq", responses: ["a"] });

  for (const url of [...calls, ...published.calls].map((c) => c.url)) assert.ok(!url.startsWith("/api/learner"), url);
});

test("the preview keeps each quiz's best score for its completion gate, and says when the draft has moved on", async () => {
  let score = 90;
  const fetcher = (async () => Response.json({ score, passed: score >= 80, passingScore: 80, correctCount: 0, autoGradableCount: 1, perQuestion: [] })) as unknown as typeof fetch;
  const onlyMcq = { [Object.keys(preview.quizKeys)[0]!]: "q-mcq" };
  const effects = previewEffects({ courseId: COURSE, target: TARGET, quizKeys: onlyMcq, requiresQuizPass: true, packageBlocks: 0, fetcher });
  await effects.submitQuiz(Object.keys(onlyMcq)[0]!, ["b"]);
  score = 10;
  await effects.submitQuiz(Object.keys(onlyMcq)[0]!, ["a"]);
  assert.deepEqual(await effects.complete(), {
    completed: true,
    serialNo: null,
    quizGate: { required: true, passed: true, totalQuizzes: 1, passedQuizzes: 1, quizzes: [{ passingScore: 80, bestScore: 90, passed: true }] },
  });

  for (const [status, message] of [[409, STALE_DRAFT], [404, GONE_DRAFT]] as const) {
    const told: string[] = [];
    const stale = previewEffects({ courseId: COURSE, target: TARGET, quizKeys: onlyMcq, requiresQuizPass: false, packageBlocks: 0, onStale: (m) => told.push(m), fetcher: recordingFetch(status, { code: "draft_conflict" }).fetcher });
    await assert.rejects(stale.submitQuiz(Object.keys(onlyMcq)[0]!, ["b"]));
    assert.deepEqual(told, [message]);
  }
});

test("a 404 says the draft is gone only for a draft preview, and a missing quiz says so for either", async () => {
  const quizId = Object.keys(preview.quizKeys)[0]!;
  const PUBLISHED: PreviewTarget = { draftId: null, versionId: "dddddddd-0000-0000-0000-0000000000aa" };
  const told = async (target: PreviewTarget, res: () => Response) => {
    const messages: string[] = [];
    const fetcher = (async () => res()) as unknown as typeof fetch;
    const effects = previewEffects({ courseId: COURSE, target, quizKeys: { [quizId]: "q-mcq" }, requiresQuizPass: false, packageBlocks: 0, onStale: (m) => messages.push(m), fetcher });
    await assert.rejects(effects.submitQuiz(quizId, ["b"]), /404/);
    return messages;
  };
  const gone = () => Response.json({ error: "Course or draft not found" }, { status: 404 });
  const missing = () => Response.json({ error: "That quiz isn't in this preview", code: "block_not_found" }, { status: 404 });
  const bare = () => new Response("Not Found", { status: 404 });

  assert.deepEqual(await told(TARGET, gone), [GONE_DRAFT]);
  assert.deepEqual(await told(TARGET, bare), [GONE_DRAFT]);
  assert.deepEqual(await told(PUBLISHED, gone), [GONE_VERSION]);
  assert.deepEqual(await told(PUBLISHED, bare), [GONE_VERSION]);
  assert.deepEqual(await told(TARGET, missing), [MISSING_QUIZ]);
  assert.deepEqual(await told(PUBLISHED, missing), [MISSING_QUIZ]);

  const route = readFileSync(new URL("../api/author/courses/[courseId]/draft/grade/route.ts", import.meta.url), "utf8");
  assert.match(route, /code: "block_not_found" \}, 404\)/, "known positive: the grade route answers block_not_found with a 404");
});

test("the learner player's own effects send what it sent before the preview existed", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(url.endsWith("/complete") ? { progress: { completed: true }, certificate: { serialNo: "FI-1" }, quizGate: null } : { score: 1 });
  }) as unknown as typeof fetch;
  try {
    const effects = learnerEffects(COURSE);
    await effects.submitQuiz("Q-1", ["b", null]);
    await effects.recordSeen("B-1");
    assert.deepEqual(await effects.complete(), { completed: true, serialNo: "FI-1", quizGate: null });
    assert.equal(effects.feedback, true);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(
    calls.map((c) => [c.url, c.init.method, JSON.parse(String(c.init.body)), c.init.keepalive ?? false]),
    [
      ["/api/learner/quiz/submit", "POST", { courseId: COURSE, quizId: "Q-1", responses: ["b", null] }, false],
      ["/api/learner/progress", "POST", { courseId: COURSE, blockId: "B-1" }, true],
      ["/api/learner/complete", "POST", { courseId: COURSE }, false],
    ],
  );
});

test("the player makes no request of its own: every write goes through its effects", () => {
  const player = readFileSync(new URL("../../components/CoursePlayer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(player, /\bfetch\(|\/api\/learner/);
  assert.match(player, /effects\s*\.submitQuiz\(/);
  assert.match(player, /effects\.recordSeen\(/);
  const page = readFileSync(new URL("./courses/[courseId]/preview/page.tsx", import.meta.url), "utf8");
  assert.match(page, /buildPreview\(/);
  assert.match(page, /<PreviewPlayer[^>]*preview=\{preview\}/);
  assert.doesNotMatch(page, /getCourseBySlug/);
});

// A checker over the one file: imports stay unresolved, but every local name
// resolves to its own declaration.
function checkedFile(file: string): { sf: ts.SourceFile; checker: ts.TypeChecker } {
  const path = fileURLToPath(new URL(file, import.meta.url));
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve, types: [] };
  const program = ts.createProgram([path], options, ts.createCompilerHost(options));
  return { sf: program.getSourceFile(path)!, checker: program.getTypeChecker() };
}

function importedName(sf: ts.SourceFile, from: string, name: "default" | string): ts.Identifier {
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== from) continue;
    const clause = statement.importClause;
    if (name === "default" && clause?.name) return clause.name;
    const bindings = clause?.namedBindings;
    const element = bindings && ts.isNamedImports(bindings) ? bindings.elements.find((e) => (e.propertyName ?? e.name).text === name) : undefined;
    if (element) return element.name;
  }
  return assert.fail(`${sf.fileName} imports no ${name} from ${from}`);
}

const PLAYER_PROPS = ["courseId", "preview", "target"];

test("the preview page hands PreviewPlayer exactly courseId, target and preview, and preview is buildPreview's output", () => {
  const { sf, checker } = checkedFile("./courses/[courseId]/preview/page.tsx");
  const player = checker.getSymbolAtLocation(importedName(sf, "@/components/author/PreviewPlayer", "default"));
  const build = checker.getSymbolAtLocation(importedName(sf, "@/lib/builder/preview", "buildPreview"));
  assert.ok(player && build);
  const line = (node: ts.Node) => `page.tsx:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

  const elements: ts.JsxSelfClosingElement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !ts.isImportClause(node.parent) && checker.getSymbolAtLocation(node) === player) {
      assert.ok(ts.isJsxSelfClosingElement(node.parent) && node.parent.tagName === node, `${line(node)} uses PreviewPlayer other than as <PreviewPlayer ... />`);
      elements.push(node.parent);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.ok(elements.length > 0, "known positive: the page renders PreviewPlayer");

  for (const element of elements) {
    const attributes = element.attributes.properties;
    for (const attribute of attributes) assert.ok(ts.isJsxAttribute(attribute), `${line(attribute)} spreads props into PreviewPlayer`);
    const named = attributes.filter(ts.isJsxAttribute);
    assert.deepEqual(named.map((a) => a.name.getText()).sort(), PLAYER_PROPS, `${line(element)} PreviewPlayer attributes`);

    const value = named.find((a) => a.name.getText() === "preview")!.initializer;
    assert.ok(value && ts.isJsxExpression(value) && value.expression && ts.isIdentifier(value.expression), `${line(element)} preview={<a name>}`);
    const declaration = checker.getSymbolAtLocation(value.expression)?.valueDeclaration;
    assert.ok(declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name), `${line(value)} preview names a variable`);
    assert.ok(ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0, `${line(declaration)} preview is const`);
    const init = declaration.initializer;
    assert.ok(
      init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && checker.getSymbolAtLocation(init.expression) === build,
      `${line(declaration)} preview is buildPreview(...) itself`,
    );
  }
});

test("PreviewPlayer's props are exactly courseId, target and preview", () => {
  const { sf, checker } = checkedFile("../../components/author/PreviewPlayer.tsx");
  const component = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && (ts.getCombinedModifierFlags(s) & ts.ModifierFlags.Default) !== 0,
  );
  assert.ok(component, "PreviewPlayer is the file's default-exported function");
  assert.equal(component.parameters.length, 1);
  const props = checker.getTypeAtLocation(component.parameters[0]!).getProperties().map((p) => p.name).sort();
  assert.deepEqual(props, PLAYER_PROPS);
});
