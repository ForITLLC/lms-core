import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Grading happens on the server (lib/db/quizzes.ts). Anything that runs in the
// browser for a learner must never hold an answer key: the deleted
// components/blocks/QuizRenderer.tsx graded in the browser from correctChoiceId.
// The browser code is every "use client" file under app/ and components/ and
// every module it value-imports, followed through app/, components/ and lib/.
// app/api is server-only and never followed. components/author is the course
// editor: it edits answer keys and only staff load it
// (app/author/author-pages.test.ts keeps learner surfaces from importing it),
// so it is neither a root nor followed. The author preview is the exception: it
// plays the course as a learner would, so it and everything it imports,
// components/author included, is scanned like learner code.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST = /\.test\.(ts|tsx|js|mjs)$/;

export const ANSWER_KEYS = new Set(["correctChoiceId", "correctChoiceIds", "correctValue", "rubricMd"]);
const ROOTS = ["app", "components"];
const FOLLOWED = ["app", "components", "lib"];
const SERVER_ONLY = ["app/api"];
const EDITOR = "components/author";
const PREVIEW = ["components/author/PreviewPlayer.tsx", "components/author/preview-effects.ts"];
// Walked, but may name the answer-key fields: these zod schemas define the
// fields and hold no answers. Each one is checked to import only zod and other
// lib/schema modules.
export const SCHEMA_ONLY = new Set(["lib/schema/blocks.ts", "lib/schema/draft.ts", "lib/schema/quiz.ts"]);

const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
export const isRoot = (file: string) =>
  PREVIEW.includes(file) || (ROOTS.some((d) => within(file, d)) && !SERVER_ONLY.some((d) => within(file, d)) && !within(file, EDITOR) && !TEST.test(file));
const followed = (file: string, fromPreview: boolean) =>
  FOLLOWED.some((d) => within(file, d)) && !SERVER_ONLY.some((d) => within(file, d)) && !TEST.test(file) && (fromPreview || !within(file, EDITOR) || PREVIEW.includes(file));

function parse(file: string, source: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".jsx") ? ts.ScriptKind.JSX : file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

export function isClientModule(sf: ts.SourceFile): boolean {
  for (const s of sf.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) return false;
    if (s.expression.text === "use client") return true;
  }
  return false;
}

// Value imports only: a type import is erased and never reaches the browser.
function valueImports(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) out.push(node.moduleSpecifier.text);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) out.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// Names in code, not comments: property access, destructuring, object keys and string literals.
export function answerKeysIn(sf: ts.SourceFile): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && ANSWER_KEYS.has(node.text)) found.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found].sort();
}

function importResolver(files: ReadonlyMap<string, string>) {
  return (from: string, specifier: string): string | null => {
    const base = specifier.startsWith("@/") ? specifier.slice(2) : specifier.startsWith(".") ? relative(ROOT, resolve(ROOT, dirname(from), specifier)).split(sep).join("/") : null;
    if (base === null) return null;
    for (const candidate of [base, ...["ts", "tsx", "js", "jsx"].flatMap((ext) => [`${base}.${ext}`, `${base}/index.${ext}`])]) {
      if (files.has(candidate)) return candidate;
    }
    return null;
  };
}

// files: repo-relative path -> source. Returns "file: key" for every browser
// file that names an answer key, and the browser files it walked.
export function clientAnswerKeys(files: ReadonlyMap<string, string>): { offenders: string[]; walked: string[] } {
  const trees = new Map<string, ts.SourceFile>();
  const tree = (file: string) => {
    let sf = trees.get(file);
    if (!sf) trees.set(file, (sf = parse(file, files.get(file)!)));
    return sf;
  };
  const resolveImport = importResolver(files);

  // A file reached from the preview is walked again in preview mode, where
  // components/author imports are followed too.
  const queue = [...files.keys()].filter((f) => isRoot(f) && isClientModule(tree(f))).map((file) => ({ file, fromPreview: PREVIEW.includes(file) }));
  const seen = new Set(queue.map(({ file, fromPreview }) => `${fromPreview}:${file}`));
  while (queue.length > 0) {
    const { file, fromPreview } = queue.pop()!;
    for (const specifier of valueImports(tree(file))) {
      const target = resolveImport(file, specifier);
      if (!target || !followed(target, fromPreview)) continue;
      const next = { file: target, fromPreview: fromPreview || PREVIEW.includes(target) };
      if (seen.has(`${next.fromPreview}:${target}`)) continue;
      seen.add(`${next.fromPreview}:${target}`);
      queue.push(next);
    }
  }
  const walked = [...new Set([...seen].map((key) => key.slice(key.indexOf(":") + 1)))].sort();
  const offenders = walked.filter((file) => !SCHEMA_ONLY.has(file)).flatMap((file) => answerKeysIn(tree(file)).map((key) => `${file}: ${key}`));
  return { offenders, walked };
}

function repoSources(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (SOURCE.test(entry.name)) files.set(path, readFileSync(join(ROOT, path), "utf8"));
    }
  };
  for (const dir of FOLLOWED) walk(dir);
  return files;
}

const QUIZ_RENDERER = `"use client";
import { useState } from "react";
import type { QuizQuestion } from "@/lib/schema/quiz";
export default function QuizRenderer({ question }: { question: QuizQuestion }) {
  const [picked, setPicked] = useState<string | null>(null);
  const correct = question.kind === "mcq" && picked === question.correctChoiceId;
  return <p>{correct ? "Correct" : "Try again"}</p>;
}`;

test("the scan flags a browser-side grader, and what a client file imports, but not comments or server files", () => {
  const flagged = (files: Record<string, string>) => clientAnswerKeys(new Map(Object.entries(files))).offenders;
  assert.deepEqual(flagged({ "components/blocks/QuizRenderer.tsx": QUIZ_RENDERER }), ["components/blocks/QuizRenderer.tsx: correctChoiceId"]);
  assert.deepEqual(
    flagged({
      "components/Player.tsx": `"use client";\nimport { grade } from "./blocks/grade";\nexport const P = () => grade;`,
      "components/blocks/grade.ts": `export const grade = (q: any, v: boolean) => q["correctValue"] === v;`,
      "components/blocks/keys.ts": `export const unused = (q: any) => q.correctChoiceIds;`,
    }),
    ["components/blocks/grade.ts: correctValue"],
  );
  assert.deepEqual(flagged({ "components/blocks/Shown.tsx": `'use client';\nexport const S = ({ rubricMd }: { rubricMd: string }) => rubricMd;` }), ["components/blocks/Shown.tsx: rubricMd"]);
  assert.deepEqual(
    flagged({
      "components/Quiet.tsx": `"use client";\n// strips correctChoiceId before this runs\nimport type { K } from "./keys";\nexport const Q = 1;`,
      "components/keys.ts": `export type K = { correctChoiceId: string };`,
      "app/learn/page.tsx": `export default function Page() { return strip({ correctChoiceId: "a" }); }`,
      "app/api/learner/quiz/route.ts": `"use client";\nexport const k = (q: any) => q.correctChoiceId;`,
      "components/author/QuizFields.tsx": `"use client";\nexport const k = (q: any) => q.correctChoiceId;`,
      "components/blocks/Late.tsx": `export const x = 1;\n"use client";\nexport const k = (q: any) => q.correctChoiceId;`,
    }),
    [],
  );
});

test("the walk follows value imports into lib/ and, from the preview only, into components/author", () => {
  const flagged = (files: Record<string, string>) => clientAnswerKeys(new Map(Object.entries(files))).offenders;
  const PLAYER = `"use client";\nimport { grade } from "@/lib/quiz/client-grade";\nexport const P = () => grade;`;
  const GRADER = `import { pick } from "./pick";\nexport const grade = (q: any, v: string) => pick(q) === v;`;
  assert.deepEqual(
    flagged({ "components/CoursePlayer.tsx": PLAYER, "lib/quiz/client-grade.ts": GRADER, "lib/quiz/pick.ts": `export const pick = (q: any) => q.correctChoiceId;` }),
    ["lib/quiz/pick.ts: correctChoiceId"],
  );
  assert.deepEqual(
    flagged({
      "components/CoursePlayer.tsx": `"use client";\nimport { QuizQuestion } from "@/lib/schema/quiz";\nimport { Extra } from "@/lib/schema/extra";\nexport const P = () => [QuizQuestion, Extra];`,
      "lib/schema/quiz.ts": `export const QuizQuestion = { correctChoiceId: "string" };`,
      "lib/schema/extra.ts": `export const Extra = { correctValue: "boolean" };`,
    }),
    ["lib/schema/extra.ts: correctValue"],
    "SCHEMA_ONLY names files, not the lib/schema directory",
  );
  assert.deepEqual(
    flagged({
      "components/CoursePlayer.tsx": `"use client";\nimport type { Q } from "@/lib/db/quizzes";\nimport { POST } from "@/app/api/learner/quiz/route";\nexport const P = (q: Q) => POST;`,
      "lib/db/quizzes.ts": `export type Q = { correctChoiceId: string };\nexport const grade = (q: any) => q.correctChoiceId;`,
      "app/api/learner/quiz/route.ts": `export const POST = (q: any) => q.correctChoiceId;`,
    }),
    [],
    "type-only imports and app/api are not followed",
  );
  const helper = `"use client";\nexport const isRight = (q: any, v: string) => q.correctChoiceId === v;`;
  assert.deepEqual(
    flagged({
      "components/author/PreviewPlayer.tsx": `"use client";\nimport { Banner } from "./fields";\nexport const P = () => Banner;`,
      "components/author/fields.tsx": `"use client";\nimport { isRight } from "./answer-helper";\nexport const Banner = () => isRight;`,
      "components/author/answer-helper.ts": helper,
    }),
    ["components/author/answer-helper.ts: correctChoiceId"],
    "components/author is followed from the preview, through other editor files",
  );
  assert.deepEqual(
    flagged({
      "components/CoursePlayer.tsx": `"use client";\nimport { isRight } from "@/components/author/answer-helper";\nexport const P = () => isRight;`,
      "components/author/answer-helper.ts": helper,
    }),
    [],
    "from learner code components/author is not followed (app/author/author-pages.test.ts keeps it out)",
  );
});

test("no browser code outside components/author names an answer key (the editor edits keys, so it is excluded)", () => {
  const files = repoSources();
  const { offenders, walked } = clientAnswerKeys(files);
  assert.ok(walked.length >= 15, `walked ${walked.length} browser files`);
  assert.ok(walked.includes("components/CoursePlayer.tsx"), "the web player is browser code");
  assert.ok(walked.includes("components/drill/DrillPlayer.tsx"), "the drill player is browser code");
  assert.ok(walked.includes("components/blocks/PackageNotice.tsx"), "a file a client component imports is walked");
  for (const preview of PREVIEW) assert.ok(walked.includes(preview), `the author preview ${preview} is scanned as learner code`);
  assert.ok(walked.some((f) => within(f, "lib")), "lib/ is followed");
  for (const schema of SCHEMA_ONLY) {
    assert.ok(within(schema, "lib/schema") && files.has(schema), `${schema} is a lib/schema module`);
    const resolveImport = importResolver(files);
    for (const specifier of valueImports(parse(schema, files.get(schema)!))) {
      const target = resolveImport(schema, specifier);
      assert.ok(specifier === "zod" || (target !== null && within(target, "lib/schema")), `${schema} imports ${specifier}, so it is not schema-only`);
    }
  }
  assert.deepEqual(offenders, []);

  const editor = [...files.keys()].filter((f) => within(f, "components/author") && !TEST.test(f));
  assert.ok(editor.some((f) => answerKeysIn(parse(f, files.get(f)!)).length > 0), "the excluded editor really does hold keys");
  for (const gone of ["components/blocks/QuizRenderer.tsx", "components/blocks/BlockRenderer.tsx"]) {
    assert.equal(existsSync(join(ROOT, gone)), false, `${gone} is back`);
  }
});
