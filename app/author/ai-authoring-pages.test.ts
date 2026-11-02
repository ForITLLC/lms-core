import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// "Create with AI" (docs/plans/2026-10-29-ai-authoring.md, slice A4): the new
// pages sit behind the one author gate, the button shows only where the
// tenant is switched on, and nothing the slice adds can publish; a draft is
// published from the course editor like any other.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

const PAGES = ["app/author/ingestions/new/page.tsx", "app/author/ingestions/[id]/page.tsx"];
const SLICE = [
  ...PAGES,
  "app/api/author/ingestions/route.ts",
  "components/author/CreateWithAiForm.tsx",
  "components/author/IngestionProgress.tsx",
  "components/author/AiDraftBanner.tsx",
  "components/author/ingestion-helpers.ts",
  "lib/ai/authoring/limits.ts",
  "lib/ai/authoring/options.ts",
];

// Comments and string text dropped, so a word in a sentence or a note doesn't count.
function code(file: string): string {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) out.push(node.text);
      return;
    }
    const children = node.getChildren(sf);
    if (children.length === 0) out.push(node.getText(sf));
    else children.forEach(visit);
  };
  visit(sf);
  return out.join(" ");
}

function defaultBody(file: string): ts.Block {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) && s.body) return s.body;
  }
  throw new Error(`${file} has no default function`);
}

test("the new pages exist and await the author gate before anything else is read", () => {
  for (const page of PAGES) {
    assert.ok(existsSync(join(ROOT, page)), page);
    const body = defaultBody(page).getText();
    const gate = body.indexOf("await requireAuthorPage(");
    assert.ok(gate > 0, page);
    assert.match(body.slice(gate), /if \(!access\.ok\)/, page);
    for (const later of ["aiAuthoringEnabled(", "<CreateWithAiForm", "<IngestionProgress"]) {
      const at = body.indexOf(later);
      assert.ok(at === -1 || at > gate, `${page}: ${later} before the gate`);
    }
  }
  assert.match(read("app/author/ingestions/new/page.tsx"), /\{enabled \? <CreateWithAiForm \/> : <p className="text-gray-700">\{AI_AUTHORING_OFF\}<\/p>\}/);
});

test("the author home shows the Create with AI button only when the tenant is switched on", () => {
  const home = read("app/author/page.tsx");
  const body = defaultBody("app/author/page.tsx").getText();
  assert.ok(body.indexOf("await requireAuthorPage(") < body.indexOf("aiAuthoringEnabled(access.tenantId)"));
  assert.match(home, /import \{ aiAuthoringEnabled \} from "@\/lib\/ai\/authoring\/limits";/);
  const button = home.indexOf('href="/author/ingestions/new"');
  assert.ok(button > 0);
  assert.equal(home.split("/author/ingestions/new").length, 2, "one link to the form");
  assert.match(home.slice(0, button), /\{aiEnabled \? \(\s*<div[^>]*>\s*<Button $/);
});

test("nothing the slice adds can publish: no publish module, URL or call", () => {
  for (const file of SLICE) {
    const text = code(file);
    assert.doesNotMatch(text, /course-publish|publishDraft|publishUrl|publishCourse|PublishPanel|\/publish\b/i, file);
  }
  // A known positive, so a scan that strips everything can't pass.
  assert.match(code("components/author/useDraft.ts"), /publishUrl/);
  assert.match(code("app/api/author/ingestions/route.ts"), /enqueueIngestionWithinLimits/);
});

test("the form posts only a source and options; the tenant and author come from the session", () => {
  const form = read("components/author/CreateWithAiForm.tsx");
  assert.match(form, /callApi<QueuedIngestionBody>\(INGESTIONS_URL, "POST", \{ source, options \}\)/);
  assert.doesNotMatch(code("components/author/CreateWithAiForm.tsx"), /tenantId|createdBy/);
  const route = code("app/api/author/ingestions/route.ts");
  assert.match(route, /enqueueIngestionWithinLimits \( gate \. tenantId ,/);
  assert.match(route, /ingestionInput \( gate \. email ,/);
});
