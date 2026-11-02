#!/usr/bin/env tsx
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { queryOne } from "@/lib/db";
import { enqueueIngestion } from "@/lib/db/ingestions";
import { ingestionInput, runIngestionInline, type SourceInput } from "@/lib/ai/authoring/job";

const USAGE = [
  "Usage: tsx scripts/ingest-youtube.ts <youtube-url> [--tenant=slug] [--created-by=email]",
  "       tsx scripts/ingest-youtube.ts --url <page-url> [--tenant=slug] [--created-by=email]",
  "       tsx scripts/ingest-youtube.ts --text-file <path> --title <title> [--tenant=slug] [--created-by=email]",
].join("\n");

type Source =
  | { kind: "youtube"; url: string }
  | { kind: "url"; url: string }
  | { kind: "text-file"; path: string; title: string };

interface Args {
  source: Source;
  tenantSlug: string;
  createdBy: string;
}

const FLAGS = new Set(["tenant", "created-by", "url", "text-file", "title"]);

// Flags take --name=value or --name value.
function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (!FLAGS.has(name)) throw new Error(`Unknown flag: ${a}\n${USAGE}`);
    const value = eq < 0 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined || value === "") throw new Error(`--${name} needs a value\n${USAGE}`);
    flags.set(name, value);
  }

  const url = flags.get("url");
  const textFile = flags.get("text-file");
  const title = flags.get("title");
  const given = [positional.length > 0, url !== undefined, textFile !== undefined].filter(Boolean).length;
  if (given !== 1 || positional.length > 1) throw new Error(USAGE);
  if ((textFile === undefined) !== (title === undefined)) throw new Error(`--text-file and --title go together\n${USAGE}`);

  const source: Source = textFile !== undefined
    ? { kind: "text-file", path: textFile, title: title! }
    : url !== undefined
      ? { kind: "url", url }
      : { kind: "youtube", url: positional[0]! };
  return { source, tenantSlug: flags.get("tenant") ?? "forit", createdBy: flags.get("created-by") ?? "ingest-cli" };
}

async function sourceInput(source: Source): Promise<SourceInput> {
  if (source.kind !== "text-file") return source;
  return { kind: "text", title: source.title, text: await readFile(source.path, "utf8") };
}

async function resolveTenantId(slug: string): Promise<string> {
  const row = await queryOne<{ TenantId: string }>(
    `SELECT TenantId FROM lms.Tenant WHERE Slug = @slug`,
    { slug },
  );
  if (!row) throw new Error(`Tenant '${slug}' not found in lms.Tenant`);
  return row.TenantId;
}

// Queues the job like the hosted flow does, then runs it here through the same
// processor the cron worker uses, retries and all.
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = args.source.kind === "text-file" ? `${args.source.path} ("${args.source.title}")` : args.source.url;
  console.log(`Authoring a draft course from ${from} for tenant '${args.tenantSlug}'...`);

  const input = ingestionInput(args.createdBy, await sourceInput(args.source));
  const tenantId = await resolveTenantId(args.tenantSlug);
  const ingestionId = await enqueueIngestion(tenantId, input);
  console.log(`  ingestionId: ${ingestionId} (${input.sourceKind})`);

  const { ingestion, course } = await runIngestionInline(tenantId, ingestionId, {
    onProgress: (p) => {
      const lessons = p.lessonsTotal === null ? "" : ` (${p.lessonsDone}/${p.lessonsTotal} lessons)`;
      console.log(`  ... ${p.stage}${lessons}`);
    },
    onWait: (job, ms) => {
      const why = job.status === "queued" && job.error ? `retrying after: ${job.error}` : `job is ${job.status}`;
      console.log(`  ... waiting ${Math.round(ms / 1000)}s (${why})`);
    },
  });

  if (ingestion.status !== "completed" || !ingestion.courseId) {
    throw new Error(`Ingestion ${ingestionId} ${ingestion.status}: ${ingestion.error ?? "no course was made"}`);
  }
  console.log("");
  console.log("✓ Draft course authored (not published):");
  if (course) {
    console.log(`  title:       ${course.title}`);
    console.log(`  slug:        ${course.slug}`);
  }
  console.log(`  courseId:    ${ingestion.courseId}`);
  console.log(`  lessons:     ${ingestion.lessonsTotal ?? "?"}`);
  if (course) console.log(`  questions:   ${course.questionCount}`);
  console.log(`  ingestionId: ${ingestionId}`);
  if (ingestion.warnings.length > 0) {
    console.log("");
    console.log(`! ${ingestion.warnings.length} generated block(s) were refused and left out:`);
    for (const d of ingestion.warnings) {
      console.log(`  lesson ${d.lesson}, block ${d.position} (${d.kind}): ${d.reason}`);
    }
  }
  console.log("");
  console.log(`Review and publish: /author/courses/${ingestion.courseId}  (on the tenant's LMS host)`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("✗ Ingest failed:", err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  },
);
