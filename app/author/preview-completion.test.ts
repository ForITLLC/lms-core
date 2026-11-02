import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PreviewCompletionRefused, previewEffects } from "@/components/author/preview-effects";
import { buildPreview } from "@/lib/builder/preview";
import * as completionGate from "@/lib/completion-gate";
import * as scope from "@/lib/db/course-scope";
import * as quizQuestions from "@/lib/db/quiz-questions";
import { DraftDoc } from "@/lib/schema/draft";

// The preview's completion must refuse and allow what the learner complete
// route does. Each case runs through the real route (with the real
// course-completion and course-finish modules over a fake database) and through
// the preview effects over the same course, and both must give the expected verdict.

const COURSE = "dddddddd-0000-0000-0000-000000000001";

function load(file: string, modules: Record<string, unknown>): Record<string, any> {
  const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(js, {
    exports,
    require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unmocked module: ${name}`);
      return modules[name];
    },
  });
  return exports;
}

interface CaseQuiz {
  questions: number;
  submitted: boolean;
  passed: boolean;
}
interface Case {
  name: string;
  requiresQuizPass: boolean;
  packageBlocks: number;
  quizzes: CaseQuiz[];
  expected: Verdict;
}
type Gate = { required: boolean; passed: boolean; totalQuizzes: number; passedQuizzes: number } | null;
type Verdict = { refused: string } | { refused: null; completes: boolean; gate: Gate };

const QUESTION = { kind: "mcq", promptMd: "Pick", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctChoiceId: "b" };
const quizId = (i: number) => `dddddddd-0000-0000-0000-0000000001${String(i).padStart(2, "0")}`;
const pickGate = (gate: Gate | undefined): Gate =>
  gate ? { required: gate.required, passed: gate.passed, totalQuizzes: gate.totalQuizzes, passedQuizzes: gate.passedQuizzes } : null;

async function learnerVerdict(c: Case): Promise<Verdict & { error?: string }> {
  const rows = c.quizzes.length === 0
    ? [{ VersionId: "V", CompletedAt: null, QuizId: null, Submitted: 0, PayloadJson: null }]
    : c.quizzes.flatMap((quiz, i) =>
        Array.from({ length: Math.max(1, quiz.questions) }, () => ({
          VersionId: "V",
          CompletedAt: null,
          QuizId: quizId(i),
          Submitted: quiz.submitted ? 1 : 0,
          PayloadJson: quiz.questions > 0 ? JSON.stringify(QUESTION) : null,
        })));
  const db = { query: async () => rows, queryOne: async () => ({ Pending: c.packageBlocks }) };
  const scores = c.quizzes.map((quiz, i) => ({
    quizId: quizId(i).toUpperCase(),
    passingScore: 80,
    bestScore: quiz.submitted ? (quiz.passed ? 90 : 10) : null,
    passed: quiz.submitted && quiz.passed,
  }));
  const progress = {
    resolveLearner: async () => ({ learnerId: "L", displayName: "Learner" }),
    ensureEnrollment: async () => true,
    markAllBlocksComplete: async () => undefined,
    getCourseProgress: async () => ({ completed: true, totalBlocks: 1, completedBlocks: 1, pct: 100 }),
    completeEnrollment: async () => undefined,
  };
  const quizzes = {
    getCourseQuizGate: async () => ({
      totalQuizzes: scores.length,
      passedQuizzes: scores.filter((s) => s.passed).length,
      passed: scores.every((s) => s.passed),
      quizzes: scores,
    }),
    courseRequiresQuizPass: async () => c.requiresQuizPass,
  };
  const completion = load("lib/db/course-completion.ts", { "@/lib/db": db, "@/lib/db/quiz-questions": quizQuestions, "@/lib/db/course-scope": scope });
  const finish = load("lib/db/course-finish.ts", {
    "@/lib/db": db,
    "@/lib/db/progress": progress,
    "@/lib/db/quizzes": quizzes,
    "@/lib/db/certificates": { issueCertificate: async () => ({ SerialNo: "CERT" }) },
    "@/lib/records/writers": { recordCourseCompletion: async () => false },
  });
  const route = load("app/api/learner/complete/route.ts", {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } },
    "@/lib/get-session": { getSessionUser: async () => ({ tenantId: "T", email: "learner@example.test", name: "Learner" }) },
    "@/lib/db/progress": progress,
    "@/lib/db/course-completion": completion,
    "@/lib/db/course-finish": finish,
    "@/lib/db/quizzes": quizzes,
    "@/lib/completion-gate": completionGate,
  });
  const res = await route.POST({ json: async () => ({ courseId: COURSE }) });
  if (res.status === 409) return { refused: res.body.code, error: res.body.error };
  assert.equal(res.status, 200, `${c.name}: learner status`);
  return { refused: null, completes: res.body.certificate !== null, gate: pickGate(res.body.quizGate) };
}

async function previewVerdict(c: Case): Promise<Verdict & { error?: string }> {
  const doc = DraftDoc.parse({
    meta: { title: "Ramp safety", requiresQuizPass: c.requiresQuizPass },
    lessons: [{
      key: "l1",
      title: "Walkaround",
      blocks: [
        { kind: "text", key: "t1", markdown: "Walk the ramp" },
        ...c.quizzes.map((quiz, i) => ({ kind: "quiz", key: `q${i}`, passingScore: 80, questions: Array.from({ length: quiz.questions }, () => QUESTION) })),
        ...Array.from({ length: c.packageBlocks }, (_, i) => ({ kind: "package", key: `p${i}`, launchableId: "dddddddd-0000-0000-0000-000000000009", title: "Ramp sim", standard: "scorm12" })),
      ],
    }],
  });
  const preview = buildPreview({ courseId: COURSE, slug: "ramp-safety" }, doc);
  const fetcher = (async (_url: string, init: RequestInit) => {
    const { blockKey } = JSON.parse(String(init.body)) as { blockKey: string };
    const passed = c.quizzes[Number(blockKey.slice(1))]!.passed;
    return Response.json({ score: passed ? 90 : 10, passed, passingScore: 80, correctCount: 0, autoGradableCount: 1, perQuestion: [] });
  }) as unknown as typeof fetch;
  const effects = previewEffects({
    courseId: COURSE,
    target: { draftId: "dddddddd-0000-0000-0000-00000000000d", revision: 1 },
    quizKeys: preview.quizKeys,
    requiresQuizPass: preview.requiresQuizPass,
    packageBlocks: preview.packageBlocks,
    fetcher,
  });
  for (const lesson of preview.lessons) {
    for (const block of lesson.blocks) {
      if (block.kind !== "quiz" || block.questions.length === 0) continue;
      if (c.quizzes[Number(preview.quizKeys[block.quizId]!.slice(1))]!.submitted) await effects.submitQuiz(block.quizId, block.questions.map(() => "a"));
    }
  }
  try {
    const outcome = await effects.complete();
    return { refused: null, completes: outcome.completed, gate: pickGate(outcome.quizGate) };
  } catch (error) {
    assert.ok(error instanceof PreviewCompletionRefused, `${c.name}: the preview refuses with PreviewCompletionRefused`);
    return { refused: error.refusal.code, error: error.message };
  }
}

const quiz = (submitted: boolean, passed: boolean, questions = 2): CaseQuiz => ({ questions, submitted, passed });
const refused = (code: string): Verdict => ({ refused: code });
const completes = (done: boolean, gate: Gate = null): Verdict => ({ refused: null, completes: done, gate });

const CASES: Case[] = [
  { name: "no quiz submitted, pass optional", requiresQuizPass: false, packageBlocks: 0, quizzes: [quiz(false, false), quiz(false, false)], expected: refused("quiz_submission_required") },
  { name: "one of two quizzes submitted, pass required", requiresQuizPass: true, packageBlocks: 0, quizzes: [quiz(true, true), quiz(false, false)], expected: refused("quiz_submission_required") },
  { name: "every quiz submitted, one failed, pass optional", requiresQuizPass: false, packageBlocks: 0, quizzes: [quiz(true, true), quiz(true, false)], expected: completes(true) },
  {
    name: "every quiz submitted, one failed, pass required",
    requiresQuizPass: true,
    packageBlocks: 0,
    quizzes: [quiz(true, true), quiz(true, false)],
    expected: completes(false, { required: true, passed: false, totalQuizzes: 2, passedQuizzes: 1 }),
  },
  {
    name: "every quiz passed, pass required",
    requiresQuizPass: true,
    packageBlocks: 0,
    quizzes: [quiz(true, true), quiz(true, true)],
    expected: completes(true, { required: true, passed: true, totalQuizzes: 2, passedQuizzes: 2 }),
  },
  { name: "a package block, every quiz passed", requiresQuizPass: false, packageBlocks: 1, quizzes: [quiz(true, true)], expected: refused("package_incomplete") },
  { name: "a package block and no quizzes", requiresQuizPass: true, packageBlocks: 2, quizzes: [], expected: refused("package_incomplete") },
  { name: "a package block and a quiz not submitted: the quiz is named first", requiresQuizPass: false, packageBlocks: 1, quizzes: [quiz(false, false)], expected: refused("quiz_submission_required") },
  {
    name: "an empty quiz does not hold completion",
    requiresQuizPass: true,
    packageBlocks: 0,
    quizzes: [quiz(false, false, 0), quiz(true, true)],
    expected: completes(true, { required: true, passed: true, totalQuizzes: 1, passedQuizzes: 1 }),
  },
  { name: "no quizzes and no package blocks", requiresQuizPass: false, packageBlocks: 0, quizzes: [], expected: completes(true) },
];

for (const c of CASES) {
  test(`preview completion matches the learner route: ${c.name}`, async () => {
    const learner = await learnerVerdict(c);
    const preview = await previewVerdict(c);
    const { error: learnerError, ...learnerRest } = learner;
    const { error: previewError, ...previewRest } = preview;
    assert.deepEqual(learnerRest, c.expected, "the learner route");
    assert.deepEqual(previewRest, c.expected, "the preview");
    assert.equal(previewError, learnerError, "the same refusal text");
  });
}
