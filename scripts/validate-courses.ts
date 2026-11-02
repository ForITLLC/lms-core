import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CourseSeed } from "@/db/seed/course-seed";

// Runtime validation of every course seed file, starter or tenant-scoped.
// TypeScript checks the shape; this catches what only zod can — bad URLs,
// non-kebab slugs, empty block arrays — before the seeder ever touches the
// database.
const COURSE_DIR = resolve("db/seed/courses");

async function main() {
  const COURSES: Record<string, unknown> = {};
  for (const file of readdirSync(COURSE_DIR).filter((f) => f.endsWith(".course.ts")).sort()) {
    const mod = (await import(pathToFileURL(join(COURSE_DIR, file)).href)) as { default: unknown };
    COURSES[file.replace(/\.course\.ts$/, "")] = mod.default;
  }

  let failed = false;
  for (const [name, raw] of Object.entries(COURSES)) {
    const result = CourseSeed.safeParse(raw);
    if (result.success) {
      const c = result.data;
      const blocks = c.lessons.reduce((n, l) => n + l.blocks.length, 0);
      const questions = c.lessons.reduce(
        (n, l) => n + (l.quiz?.questions.length ?? 0),
        0,
      );
      console.log(
        `  ok  ${name}: ${c.lessons.length} lessons, ${blocks} blocks, ` +
          `${questions} quiz questions [${c.mandatory ? "mandatory" : "optional"}]`,
      );
    } else {
      failed = true;
      console.error(`  FAIL ${name}:`);
      for (const issue of result.error.issues) {
        console.error(`    ${issue.path.join(".")}: ${issue.message}`);
      }
    }
  }

  if (failed) {
    console.error("Course validation failed.");
    process.exit(1);
  }
  console.log("All course seeds valid.");
}

void main();
