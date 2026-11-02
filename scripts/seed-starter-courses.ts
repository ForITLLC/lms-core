import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execute } from "@/lib/db";
import {
  getStarterCourseSlugs,
  loadStarterCourses,
} from "@/db/seed/load-starter-courses";

// CLI seeder for the ForIT starter library. Loads the mandatory phishing
// course plus the optional Copilot primers into a tenant and wires them into
// that tenant's default curriculum. Both the migration and the load are
// idempotent, so re-running is safe.
//
//   npx tsx scripts/seed-starter-courses.ts --tenant <TenantId> [--migrate=NAME]...
//
// --migrate=NAME applies db/migrations/<NAME> batch-by-batch on GO. Pass once
// per migration that hasn't been applied yet (idempotent — every statement is
// guarded). Examples:
//   --migrate=0002_lms_progress_certs_curriculum
//   --migrate=0003_recurrence_hr_groups
//
// --force <slug,slug|all> republishes those courses: loadCourseSeed inserts a
// new CourseVersion and content tree. Old versions are kept, so in-flight
// learners stay on the version they enrolled on. Without --force an existing
// course is skipped untouched. Example:
//   --force forit-agile-fundamentals

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function migrationsRequested(): string[] {
  return process.argv
    .filter((a) => a.startsWith("--migrate="))
    .map((a) => a.slice("--migrate=".length));
}

function forceSlugsRequested(): Set<string> {
  const raw = arg("force")?.trim() ?? "";
  if (!raw) return new Set<string>();
  const slugs = new Set(
    raw.split(",").map((s) => s.trim()).filter(Boolean),
  );
  return slugs.has("all") ? new Set(getStarterCourseSlugs()) : slugs;
}

async function applyMigrationFile(name: string): Promise<void> {
  const path = join(process.cwd(), `db/migrations/${name}.sql`);
  const sql = await readFile(path, "utf8");
  const batches = sql
    .split(/^\s*GO\s*$/im)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  console.log(`Applying migration ${name} — ${batches.length} batch(es)…`);
  for (let i = 0; i < batches.length; i++) {
    await execute(batches[i]!);
    console.log(`  batch ${i + 1}/${batches.length} ok`);
  }
}

async function main(): Promise<void> {
  const tenantId = arg("tenant") ?? process.env.SEED_TENANT_ID;
  const createdBy =
    arg("created-by") ?? process.env.SEED_CREATED_BY ?? "starter-seed";

  if (!tenantId) {
    console.error(
      "Usage: npx tsx scripts/seed-starter-courses.ts --tenant <lms.Tenant.TenantId> [--created-by <id>] [--migrate=NAME] [--force <slug,slug|all>]",
    );
    process.exit(1);
  }

  for (const name of migrationsRequested()) {
    await applyMigrationFile(name);
  }

  const forceSlugs = forceSlugsRequested();
  if (forceSlugs.size > 0) {
    console.log(`Force-republishing: ${Array.from(forceSlugs).join(", ")}`);
  }
  console.log(`Seeding starter courses into tenant ${tenantId}…`);
  const outcomes = await loadStarterCourses({ tenantId, createdBy, forceSlugs });
  for (const o of outcomes) {
    const detail =
      o.status === "created"
        ? `, ${o.lessonCount} lessons, ${o.questionCount} questions`
        : "";
    console.log(
      `  ${o.status === "created" ? "+" : "="} ${o.title} ` +
        `[${o.mandatory ? "mandatory" : "optional"}] — ${o.status}${detail}`,
    );
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
