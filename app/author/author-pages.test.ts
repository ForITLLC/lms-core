import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The course builder's boundary (docs/plans/2026-10-28-course-builder-mvp.md, S4):
// the author UI holds answer keys, so learner surfaces never import it; every
// author page goes through the one staff check; and the author components reach
// drafts only through /api/author, never lib/db. Sources are read as syntax
// trees, so a commented-out import or gate call counts for nothing.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourcesUnder(path));
    else if (SOURCE.test(entry.name)) out.push(path);
  }
  return out;
}

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

function parse(file: string, source: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".ts") ? ts.ScriptKind.TS : file.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

// A specifier this check can't read, such as import(`./${name}`).
export const COMPUTED = "<computed>";

export function importsOf(source: string, file = "x.tsx"): string[] {
  const out: string[] = [];
  const specifier = (node: ts.Node | undefined) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : COMPUTED;
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) out.push(specifier(node.moduleSpecifier));
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) out.push(specifier(node.moduleReference.expression));
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) out.push(specifier(node.argument.literal));
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      out.push(specifier(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file, source));
  return out;
}

// A specifier as a repo-relative path: "@/x" is the repo root, "./x" and
// "../x" are relative to the importing file, anything else is a package.
export function importTarget(file: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return specifier.slice(2);
  if (specifier.startsWith(".")) return relative(ROOT, resolve(ROOT, dirname(file), specifier)).split(sep).join("/");
  return null;
}

const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

export function reachesAuthorComponents(file: string, specifier: string): boolean {
  if (specifier === COMPUTED) return true;
  const target = importTarget(file, specifier);
  return target !== null && within(target, "components/author");
}

const DB_PACKAGES = ["@foritllc/db", "mssql", "tedious"];

export function reachesDatabase(file: string, specifier: string): boolean {
  if (specifier === COMPUTED) return true;
  if (DB_PACKAGES.some((pkg) => within(specifier, pkg))) return true;
  const target = importTarget(file, specifier)?.replace(SOURCE, "");
  return target !== undefined && within(target, "lib/db");
}

// Next's server-rendered route files. Each one under app/author exports its
// default and static segment config only, so no generateMetadata or other
// export can read data outside the gate.
const ROUTE_MODULE = /(^|\/)(page|layout|template|default|loading|not-found)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SEGMENT_CONFIG = new Set(["dynamic", "dynamicParams", "revalidate", "fetchCache", "runtime", "preferredRegion", "maxDuration", "metadata", "viewport"]);

function isStatic(node: ts.Expression): boolean {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return isStatic(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node)) return true;
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(isStatic);
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((p) => ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && isStatic(p.initializer));
  }
  return false;
}

const isGateCall = (node: ts.Expression | undefined): boolean =>
  node !== undefined &&
  ts.isAwaitExpression(node) &&
  ts.isCallExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === "requireAuthorPage";

// The gate is a statement of the function itself, not inside a branch or a
// closure that might not run.
function gatesAtTopLevel(fn: ts.FunctionLikeDeclaration | undefined): boolean {
  const body = fn?.body;
  if (!body || !ts.isBlock(body)) return false;
  return body.statements.some((s) =>
    ts.isExpressionStatement(s)
      ? isGateCall(s.expression)
      : ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => isGateCall(d.initializer)),
  );
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

export function routeModuleProblems(file: string, source: string): string[] {
  const sf = parse(file, source);
  const problems: string[] = [];
  const localFunction = (name: string): ts.FunctionLikeDeclaration | undefined => {
    for (const s of sf.statements) {
      if (ts.isFunctionDeclaration(s) && s.name?.text === name) return s;
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) return d.initializer;
        }
      }
    }
    return undefined;
  };

  let defaults = 0;
  for (const s of sf.statements) {
    if (ts.isExportAssignment(s)) {
      defaults += 1;
      const target = ts.isIdentifier(s.expression) ? localFunction(s.expression.text)
        : ts.isArrowFunction(s.expression) || ts.isFunctionExpression(s.expression) ? s.expression : undefined;
      if (!gatesAtTopLevel(target)) problems.push("the default export does not await requireAuthorPage at its top level");
    } else if (ts.isExportDeclaration(s)) {
      if (!s.isTypeOnly) problems.push("re-exports are not allowed");
    } else if (hasModifier(s, ts.SyntaxKind.ExportKeyword)) {
      if (ts.isFunctionDeclaration(s) && hasModifier(s, ts.SyntaxKind.DefaultKeyword)) {
        defaults += 1;
        if (!gatesAtTopLevel(s)) problems.push("the default export does not await requireAuthorPage at its top level");
      } else if (ts.isVariableStatement(s) && s.declarationList.flags & ts.NodeFlags.Const) {
        for (const d of s.declarationList.declarations) {
          const name = ts.isIdentifier(d.name) ? d.name.text : "?";
          if (!SEGMENT_CONFIG.has(name) || !d.initializer || !isStatic(d.initializer)) problems.push(`export ${name} is not static segment config`);
        }
      } else if (!ts.isTypeAliasDeclaration(s) && !ts.isInterfaceDeclaration(s)) {
        problems.push(`the export on line ${sf.getLineAndCharacterOfPosition(s.getStart()).line + 1} is not the default or static segment config`);
      }
    }
  }
  if (defaults !== 1) problems.push(`has ${defaults} default exports`);

  const gateImport = sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === "@/lib/auth/author-page" &&
      !s.importClause?.isTypeOnly &&
      s.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(s.importClause.namedBindings) &&
      s.importClause.namedBindings.elements.some((e) => e.name.text === "requireAuthorPage" && !e.propertyName && !e.isTypeOnly),
  );
  if (!gateImport) problems.push("does not import requireAuthorPage from @/lib/auth/author-page");
  if (/\bgetSessionUser\b|\bisStaffRole\b|session\.role/.test(source)) problems.push("checks the session itself instead of leaving it to requireAuthorPage");
  problems.push(...gateArgumentProblems(file, sf));
  return problems;
}

// The pages that open the gate wider than staff, and the one check each may
// pass (card d3e16430: an instructor and a training manager mark exams, so
// they reach the marking queue and no other author page). Every other page
// passes the path alone and keeps the staff check.
export const WIDER_GATES: Record<string, string> = { "app/author/grading/page.tsx": "canMarkExams" };
const RECORDS_PERMISSIONS = "@/lib/auth/records-permissions";

function gateArgumentProblems(file: string, sf: ts.SourceFile): string[] {
  const wider = WIDER_GATES[file];
  const problems: string[] = [];
  let widened = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "requireAuthorPage") {
      const args = node.arguments;
      const check = args[1];
      if (args.some(ts.isSpreadElement) || args.length > 2) problems.push("passes requireAuthorPage arguments this check can't read");
      else if (check && !(wider && ts.isIdentifier(check) && check.text === wider)) {
        problems.push(wider ? `may widen requireAuthorPage only with ${wider}` : "widens requireAuthorPage, which only the pages in WIDER_GATES may do");
      } else if (check) widened = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (widened) {
    const imported = sf.statements.some(
      (s) =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text === RECORDS_PERMISSIONS &&
        !s.importClause?.isTypeOnly &&
        s.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(s.importClause.namedBindings) &&
        s.importClause.namedBindings.elements.some((e) => e.name.text === wider && !e.propertyName && !e.isTypeOnly),
    );
    if (!imported) problems.push(`does not import ${wider} from ${RECORDS_PERMISSIONS}`);
  }
  return problems;
}

const AUTHOR_ONLY = ["app/author", "components/author", "app/api/author"];
const LEARNER_SURFACES = ["app", "components", "lib", "db"];
const routeModules = sourcesUnder("app/author").filter((f) => ROUTE_MODULE.test(f));

const GATED = `import { requireAuthorPage } from "@/lib/auth/author-page";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireAuthorPage("/author/" + id);
  return access.ok ? id : null;
}`;

test("the import checks recognise the imports they guard against", () => {
  assert.equal(reachesAuthorComponents("app/learn/page.tsx", "@/components/author/CourseEditor"), true);
  assert.equal(reachesAuthorComponents("components/CoursePlayer.tsx", "./author/BlockPreview"), true);
  assert.equal(reachesAuthorComponents("app/learn/[slug]/page.tsx", "../../../components/author"), true);
  assert.equal(reachesAuthorComponents("lib/reexport.ts", "../components/author/CourseEditor"), true);
  assert.equal(reachesAuthorComponents("app/learn/page.tsx", COMPUTED), true);
  assert.equal(reachesAuthorComponents("app/learn/page.tsx", "@/components/authoring/x"), false);
  assert.equal(reachesAuthorComponents("app/learn/page.tsx", "@/components/Button"), false);
  assert.equal(reachesDatabase("components/author/x.tsx", "@/lib/db"), true);
  assert.equal(reachesDatabase("components/author/x.tsx", "@/lib/db/course-drafts"), true);
  assert.equal(reachesDatabase("components/author/x.tsx", "../../lib/db/course-drafts.ts"), true);
  assert.equal(reachesDatabase("components/author/x.tsx", "@foritllc/db"), true);
  assert.equal(reachesDatabase("components/author/x.tsx", "mssql"), true);
  assert.equal(reachesDatabase("components/author/x.tsx", "mssql/msnodesqlv8"), true);
  assert.equal(reachesDatabase("components/author/x.tsx", COMPUTED), true);
  assert.equal(reachesDatabase("components/author/x.tsx", "@foritllc/db-tools"), false);
  assert.equal(reachesDatabase("components/author/x.tsx", "@/lib/db-tools"), false);
  assert.equal(reachesDatabase("components/author/x.tsx", "@/lib/schema/draft"), false);
  assert.deepEqual(
    importsOf(
      [
        `import a from "x";`,
        `import type { B } from 'y';`,
        `export { c } from "z";`,
        `import "side";`,
        "const d = await import(`tpl`);",
        `const e = require("req");`,
        `import f = require("eq");`,
        `type G = import("typed").G;`,
        `// import h from "line-comment";`,
        `/* await import("block-comment") */`,
        `const s = 'import i from "in-a-string"';`,
        "const t = await import(`@/components/author/${name}`);",
      ].join("\n"),
    ),
    ["x", "y", "z", "side", "tpl", "req", "eq", "typed", COMPUTED],
  );
  assert.deepEqual(importsOf(`const P = () => <div/>;\nexport default P;\nimport("./author/x.jsx");`, "app/learn/page.jsx"), ["./author/x.jsx"]);

  // Known positives in the real tree, so a scan that matches nothing can't pass.
  const editorPage = routeModules.find((f) => f.includes("/courses/"));
  assert.ok(editorPage, "the course editor page exists");
  assert.ok(importsOf(read(editorPage), editorPage).some((s) => reachesAuthorComponents(editorPage, s)));
  assert.ok(importsOf(read("app/author/page.tsx"), "app/author/page.tsx").some((s) => reachesDatabase("app/author/page.tsx", s)));
});

test("the route-file rule refuses a commented-out gate, a gate in a branch, generateMetadata and computed config", () => {
  assert.deepEqual(routeModuleProblems("page.tsx", GATED), []);
  const refused = (source: string) => assert.notDeepEqual(routeModuleProblems("page.tsx", source), [], source);
  refused(GATED.replace(`const access = await requireAuthorPage("/author/" + id);`, `// const access = await requireAuthorPage("/author/" + id);\n  const access = { ok: true };`));
  refused(GATED.replace(`const access = await requireAuthorPage("/author/" + id);`, `/* await requireAuthorPage( */ const access = { ok: true };`));
  refused(GATED.replace(`const access = await requireAuthorPage("/author/" + id);`, `if (id === "x") await requireAuthorPage("/a"); const access = { ok: true };`));
  refused(GATED.replace(`const access = await requireAuthorPage("/author/" + id);`, `const later = async () => await requireAuthorPage("/a"); const access = { ok: true };`));
  refused(`${GATED}\nexport async function generateMetadata() { return { title: await listAuthorCourses("t") }; }`);
  refused(`${GATED}\nexport const generateMetadata = async () => ({ title: "x" });`);
  refused(`${GATED}\nexport const revalidate = compute();`);
  refused(`${GATED}\nexport { generateMetadata } from "./meta";`);
  refused(GATED.replace(`import { requireAuthorPage } from "@/lib/auth/author-page";`, `import { requireAuthorPage } from "@/lib/fake-gate";`));
  refused(`${GATED}\nconst s = await getSessionUser();`);
  assert.deepEqual(routeModuleProblems("page.tsx", `${GATED}\nexport const metadata = { title: "Author tools" };\nexport type X = string;`), []);
});

test("only the marking queue widens the gate, and only with canMarkExams from records-permissions", () => {
  const GRADING = "app/author/grading/page.tsx";
  const CALL = `const access = await requireAuthorPage("/author/" + id);`;
  const widen = (check: string) => GATED.replace(CALL, `const access = await requireAuthorPage("/author/" + id, ${check});`);
  const IMPORT = `import { canMarkExams } from "@/lib/auth/records-permissions";\n`;

  assert.deepEqual(routeModuleProblems(GRADING, IMPORT + widen("canMarkExams")), [], "known positive");
  assert.deepEqual(routeModuleProblems(GRADING, GATED), [], "the marking queue may also keep the staff check");

  const refused = (file: string, source: string) => assert.notDeepEqual(routeModuleProblems(file, source), [], `${file}: ${source}`);
  refused("app/author/page.tsx", IMPORT + widen("canMarkExams"));
  refused("app/author/courses/[id]/page.tsx", IMPORT + widen("canMarkExams"));
  refused(GRADING, widen("canMarkExams"));
  refused(GRADING, `import { canMarkExams } from "@/lib/fake-permissions";\n${widen("canMarkExams")}`);
  refused(GRADING, `import type { canMarkExams } from "@/lib/auth/records-permissions";\n${widen("canMarkExams")}`);
  refused(GRADING, `import { canReadRecords as canMarkExams } from "@/lib/auth/records-permissions";\n${widen("canMarkExams")}`);
  refused(GRADING, IMPORT + widen("() => true"));
  refused(GRADING, IMPORT + widen("canReadRecords"));
  refused(GRADING, IMPORT + widen("(r) => canMarkExams(r) || true"));
  refused(GRADING, IMPORT + widen("canMarkExams, extra"));
  refused(GRADING, IMPORT + GATED.replace(CALL, `const args = ["/a", () => true] as const; const access = await requireAuthorPage(...args);`));

  assert.match(read(GRADING), /await requireAuthorPage\("\/author\/grading", canMarkExams\)/, "the real marking queue lets an instructor in");
});

test("no file outside the author directories imports the author components, including lib/ re-exports", () => {
  const files = LEARNER_SURFACES.flatMap((dir) => sourcesUnder(dir)).filter((f) => !AUTHOR_ONLY.some((dir) => within(f, dir)));
  assert.ok(files.length > 50, `scanned ${files.length} files`);
  assert.ok(files.some((f) => f.startsWith("lib/")) && files.some((f) => f.startsWith("app/")));
  const offenders = files.flatMap((file) =>
    importsOf(read(file), file)
      .filter((s) => reachesAuthorComponents(file, s))
      .map((s) => `${file} imports ${s}`),
  );
  assert.deepEqual(offenders, []);
});

test("every app/author route file (any extension) exports only a default that awaits requireAuthorPage, plus static segment config", () => {
  assert.ok(routeModules.length >= 2, `found ${routeModules.join(", ")}`);
  const problems = routeModules.flatMap((file) => routeModuleProblems(file, read(file)).map((p) => `${file}: ${p}`));
  assert.deepEqual(problems, []);
});

test("the author components never import lib/db or a database driver", () => {
  const files = sourcesUnder("components/author");
  assert.ok(files.length > 0);
  const offenders = files.flatMap((file) =>
    importsOf(read(file), file)
      .filter((s) => reachesDatabase(file, s))
      .map((s) => `${file} imports ${s}`),
  );
  assert.deepEqual(offenders, []);
});
