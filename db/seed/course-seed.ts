import { randomUUID } from "node:crypto";
import { z } from "zod";
import { execute, queryOne } from "@/lib/db";
import { TextBlock, CalloutBlock, ImageBlock, EmbedBlock, VideoBlock } from "@/lib/schema/blocks";
import { QuizQuestion } from "@/lib/schema/quiz";
import quizRegistryRaw from "@/db/seed/lesson-quizzes.json";

// A CourseSeed is a fully-authored course expressed as plain data. The AI
// authoring pipeline (lib/ai/authoring) produces these shapes from a YouTube
// video; the starter library hand-authors them so the same loader serves both.
// Quiz blocks are NOT listed under `blocks` — a lesson carries at most one
// quiz via `quiz`, which the loader appends as the final block of the lesson.

export const SeedContentBlock = z.discriminatedUnion("kind", [
  TextBlock,
  CalloutBlock,
  ImageBlock,
  EmbedBlock,
  VideoBlock,
]);
export type SeedContentBlock = z.infer<typeof SeedContentBlock>;

export const LessonSeed = z.object({
  title: z.string().min(1),
  estMinutes: z.number().int().positive(),
  blocks: z.array(SeedContentBlock).min(1),
  quiz: z
    .object({
      passingScore: z.number().int().min(1).max(100).default(70),
      questions: z.array(QuizQuestion).min(1),
    })
    .optional(),
});
export type LessonSeed = z.infer<typeof LessonSeed>;

export const CourseSeed = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, "slug must be kebab-case"),
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.enum(["security", "productivity", "engineering"]),
  // Mandatory courses are added to the tenant's default curriculum with
  // IsMandatory=1; optional ones with IsMandatory=0. See db/seed/load-starter-courses.
  mandatory: z.boolean().default(false),
  // M4 completion gating. When true, the course only completes (and mints a
  // certificate) once the learner clears every quiz's PassingScore — see
  // lib/db/quizzes.ts + app/api/learner/complete. Omitted (the default for
  // every existing course) keeps the view-to-complete behavior — the loader
  // treats absence as false and the DB column defaults to 0. Left .optional()
  // rather than .default(false) so the 26 pre-existing seeds typecheck without
  // each having to declare it.
  requiresQuizPass: z.boolean().optional(),
  // Schedule mode (drives lms.Course.ScheduleKind, see lib/db/schedule.ts):
  //   'annual'    → due Jan 31 each year, recurrenceMonths ignored.
  //   'recurring' → due every recurrenceMonths from learner start / last issue.
  //   omitted     → evergreen, cert never expires.
  scheduleKind: z.enum(["annual", "recurring"]).optional(),
  recurrenceMonths: z.number().int().positive().optional(),
  // Free-form catalog tags. Lowercased + deduped on insert. Drives the
  // /learn search box + tag chip filters; not a permission boundary.
  tags: z.array(z.string().min(1)).default([]),
  lessons: z.array(LessonSeed).min(1),
});
export type CourseSeed = z.infer<typeof CourseSeed>;

export interface LoadCourseOpts {
  tenantId: string;
  createdBy: string;
  publish?: boolean;
  // When true and a course with this slug already exists: create a NEW
  // CourseVersion (vN+1) and a fresh Lesson/Block/Quiz/QuizQuestion tree
  // tagged with that version. Old rows are NEVER deleted — Progress and
  // QuizAttempt rows that reference the prior version stay valid, so
  // in-flight learners keep seeing the version they enrolled on.
  // Course.CurrentVersionId moves to the new version, so first-touch
  // enrollments going forward start on vN+1.
  force?: boolean;
}

export interface LoadCourseResult {
  courseId: string;
  slug: string;
  versionId: string;
  versionNumber: number;
  status: "created" | "skipped" | "replaced";
  lessonCount: number;
  questionCount: number;
}

// Registry of end-of-lesson quizzes generated from lesson content by
// scripts/generate-quizzes.ts. Key shape: "<courseSlug>/<lessonIndex>". When
// a lesson seed does not declare its own .quiz, the loader merges the
// registry entry in below — so the same starter library powers both the
// hand-authored quizzes that ship inline AND the AI-generated knowledge
// tests sourced from this file. Bundled into the standalone Next.js output
// alongside db/migrations.
const QuizRegistryEntry = z.object({
  passingScore: z.number().int().min(1).max(100).default(70),
  questions: z.array(QuizQuestion).min(1),
  overridesInline: z.boolean().optional(),
});
const QuizRegistryFile = z.object({
  _format: z.string().optional(),
  _doc: z.string().optional(),
  quizzes: z.record(z.string(), QuizRegistryEntry),
});

let cachedRegistry: Record<string, z.infer<typeof QuizRegistryEntry>> | null = null;
function loadQuizRegistry(): Record<string, z.infer<typeof QuizRegistryEntry>> {
  if (cachedRegistry) return cachedRegistry;
  try {
    cachedRegistry = QuizRegistryFile.parse(quizRegistryRaw).quizzes;
  } catch {
    cachedRegistry = {};
  }
  return cachedRegistry;
}

// A course an author has opened or published in the course builder belongs
// to the builder: the seed neither refreshes nor republishes it.
const BUILDER_OWNED = `(EXISTS (SELECT 1 FROM lms.CourseDraft d WHERE d.TenantId = c.TenantId AND d.CourseId = c.CourseId)
   OR EXISTS (SELECT 1 FROM lms.AuditEvent a
               WHERE a.TenantId = c.TenantId AND a.Verb = 'course.publish'
                 AND a.ObjectId = LOWER(CONVERT(varchar(36), c.CourseId))))`;

// Idempotent: if a course with the same (tenantId, slug) already exists the
// loader skips its content untouched. Re-authoring an existing course is a
// deliberate admin action (opts.force=true) that publishes a new version —
// not a side effect of re-running the seeder.
export async function loadCourseSeed(
  raw: CourseSeed,
  opts: LoadCourseOpts,
): Promise<LoadCourseResult> {
  const seed = CourseSeed.parse(raw);

  const registry = loadQuizRegistry();
  for (let li = 0; li < seed.lessons.length; li++) {
    const lesson = seed.lessons[li]!;
    const entry = registry[`${seed.slug}/${li}`];
    if (entry && (!lesson.quiz || entry.overridesInline)) {
      lesson.quiz = { passingScore: entry.passingScore, questions: entry.questions };
    }
  }

  const normalizedTags = Array.from(
    new Set(seed.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)),
  );
  const tagsJson = normalizedTags.length > 0 ? JSON.stringify(normalizedTags) : null;

  const existing = await queryOne<{ CourseId: string; CurrentVersionId: string | null; BuilderOwned: number }>(
    `SELECT c.CourseId, CONVERT(varchar(64), c.CurrentVersionId) AS CurrentVersionId,
            CASE WHEN ${BUILDER_OWNED} THEN 1 ELSE 0 END AS BuilderOwned
       FROM lms.Course c
      WHERE c.TenantId = @tenantId AND c.Slug = @slug`,
    { tenantId: opts.tenantId, slug: seed.slug },
  );

  if (existing && (!opts.force || existing.BuilderOwned)) {
    // Refresh catalog metadata even on skip so re-running the seeder picks up
    // tag/category edits without forcing a full reauthor. Content stays
    // pinned to the existing CurrentVersionId.
    if (!existing.BuilderOwned) {
      await execute(
        `UPDATE lms.Course
            SET Category = @category,
                Tags     = @tags
          WHERE CourseId = @courseId`,
        {
          courseId: existing.CourseId,
          category: seed.category,
          tags: tagsJson,
        },
      );
    }
    const currentVersion = existing.CurrentVersionId
      ? await queryOne<{ VersionId: string; VersionNumber: number }>(
          `SELECT CONVERT(varchar(64), VersionId) AS VersionId, VersionNumber
             FROM lms.CourseVersion
            WHERE VersionId = @versionId`,
          { versionId: existing.CurrentVersionId },
        )
      : null;
    return {
      courseId: existing.CourseId,
      slug: seed.slug,
      versionId: currentVersion?.VersionId ?? "",
      versionNumber: currentVersion?.VersionNumber ?? 0,
      status: "skipped",
      lessonCount: 0,
      questionCount: 0,
    };
  }

  const status = (opts.publish ?? true) ? "published" : "draft";
  let courseId: string;
  let outcome: "created" | "replaced";

  if (existing && opts.force) {
    // The lesson tree is NOT wiped: a new CourseVersion and fresh content rows
    // are inserted below, and the metadata moves with the version pointer.
    courseId = existing.CourseId;
    outcome = "replaced";
  } else {
    courseId = randomUUID();
    outcome = "created";

    await execute(
      `INSERT INTO lms.Course
         (CourseId, TenantId, Title, Slug, Description, Status, Category,
          ScheduleKind, RecurrenceMonths, Tags, CreatedBy)
       VALUES
         (@courseId, @tenantId, @title, @slug, @description, @status, @category,
          @scheduleKind, @recurrenceMonths, @tags, @createdBy)`,
      {
        courseId,
        tenantId: opts.tenantId,
        title: seed.title,
        slug: seed.slug,
        description: seed.description,
        status,
        category: seed.category,
        scheduleKind: seed.scheduleKind ?? null,
        recurrenceMonths: seed.recurrenceMonths ?? null,
        tags: tagsJson,
        createdBy: opts.createdBy,
      },
    );
  }

  // Allocate the next version number. For a brand-new course this is v1
  // (no prior CourseVersion rows); for a force publish it's MAX+1.
  const maxRow = await queryOne<{ MaxNum: number | null }>(
    `SELECT MAX(VersionNumber) AS MaxNum
       FROM lms.CourseVersion
      WHERE CourseId = @courseId`,
    { courseId },
  );
  const versionNumber = (maxRow?.MaxNum ?? 0) + 1;
  const versionId = randomUUID();
  await execute(
    `INSERT INTO lms.CourseVersion
       (VersionId, CourseId, VersionNumber, PublishedBy, ChangeNote)
     VALUES (@versionId, @courseId, @versionNumber, @publishedBy, @changeNote)`,
    {
      versionId,
      courseId,
      versionNumber,
      publishedBy: opts.createdBy,
      changeNote: outcome === "created"
        ? "Initial publish"
        : `Republished via seed loader (v${versionNumber})`,
    },
  );

  let questionCount = 0;

  for (let li = 0; li < seed.lessons.length; li++) {
    const lesson = seed.lessons[li]!;
    const lessonId = randomUUID();
    await execute(
      `INSERT INTO lms.Lesson (LessonId, CourseId, VersionId, Title, OrderIndex, EstMinutes)
       VALUES (@lessonId, @courseId, @versionId, @title, @orderIndex, @estMinutes)`,
      {
        lessonId,
        courseId,
        versionId,
        title: lesson.title,
        orderIndex: li,
        estMinutes: lesson.estMinutes,
      },
    );

    // Auto-prepend a category-themed hero illustration so every lesson opens
    // with a visual. The seed author can override by placing an image block
    // first in `blocks` — we detect that and skip the auto-hero.
    const firstAuthoredBlock = lesson.blocks[0];
    const authorProvidedHero =
      firstAuthoredBlock !== undefined && firstAuthoredBlock.kind === "image";
    const effectiveBlocks: SeedContentBlock[] = authorProvidedHero
      ? lesson.blocks
      : [categoryHeroBlock(seed.category, lesson.title), ...lesson.blocks];

    for (let bi = 0; bi < effectiveBlocks.length; bi++) {
      const block = effectiveBlocks[bi]!;
      await execute(
        `INSERT INTO lms.Block (BlockId, LessonId, VersionId, Kind, OrderIndex, PayloadJson)
         VALUES (@blockId, @lessonId, @versionId, @kind, @orderIndex, @payload)`,
        {
          blockId: randomUUID(),
          lessonId,
          versionId,
          kind: block.kind,
          orderIndex: bi,
          payload: JSON.stringify(block),
        },
      );
    }

    if (lesson.quiz) {
      const quizBlockId = randomUUID();
      const quizId = randomUUID();
      await execute(
        `INSERT INTO lms.Block (BlockId, LessonId, VersionId, Kind, OrderIndex, PayloadJson)
         VALUES (@blockId, @lessonId, @versionId, 'quiz', @orderIndex, @payload)`,
        {
          blockId: quizBlockId,
          lessonId,
          versionId,
          orderIndex: effectiveBlocks.length,
          payload: JSON.stringify({ kind: "quiz", quizId }),
        },
      );
      await execute(
        `INSERT INTO lms.Quiz (QuizId, BlockId, VersionId, PassingScore)
         VALUES (@quizId, @blockId, @versionId, @passingScore)`,
        { quizId, blockId: quizBlockId, versionId, passingScore: lesson.quiz.passingScore },
      );
      for (let qi = 0; qi < lesson.quiz.questions.length; qi++) {
        const question = lesson.quiz.questions[qi]!;
        await execute(
          `INSERT INTO lms.QuizQuestion (QuestionId, QuizId, VersionId, Kind, OrderIndex, PromptMd, PayloadJson)
           VALUES (@questionId, @quizId, @versionId, @kind, @orderIndex, @promptMd, @payload)`,
          {
            questionId: randomUUID(),
            quizId,
            versionId,
            kind: question.kind,
            orderIndex: qi,
            promptMd: question.promptMd,
            payload: JSON.stringify(question),
          },
        );
        questionCount += 1;
      }
    }
  }

  // Promote the new version to current AFTER the content tree is fully
  // inserted, so a partial publish can't leave learners pointed at an
  // empty version. The move only happens if nobody else published and no
  // author took the course into the builder meanwhile; otherwise the new
  // version is left unused and the seed stops.
  const previousVersionId = existing && opts.force ? existing.CurrentVersionId : null;
  const moved = await execute(
    `UPDATE c
        SET Title            = @title,
            Description      = @description,
            Status           = @status,
            Category         = @category,
            ScheduleKind     = @scheduleKind,
            RecurrenceMonths = @recurrenceMonths,
            Tags             = @tags,
            CurrentVersionId = @versionId
       FROM lms.Course c
      WHERE c.TenantId = @tenantId AND c.CourseId = @courseId
        AND ${previousVersionId ? "c.CurrentVersionId = @previousVersionId" : "c.CurrentVersionId IS NULL"}
        AND NOT ${BUILDER_OWNED}`,
    {
      tenantId: opts.tenantId,
      courseId,
      versionId,
      previousVersionId,
      title: seed.title,
      description: seed.description,
      status,
      category: seed.category,
      scheduleKind: seed.scheduleKind ?? null,
      recurrenceMonths: seed.recurrenceMonths ?? null,
      tags: tagsJson,
    },
  );
  if (moved === 0) {
    throw new Error(
      `loadCourseSeed: ${seed.slug} changed while it was being seeded (published or opened in the course builder); version ${versionNumber} was not made current`,
    );
  }

  // M4 opt-in completion gating. Guarded on COL_LENGTH so seeding still works
  // against a DB that hasn't had migration 0015 applied (column absent ⇒
  // no-op). Courses that don't opt in are left at the column default (0).
  if (seed.requiresQuizPass) {
    await execute(
      `IF COL_LENGTH('lms.Course', 'RequiresQuizPass') IS NOT NULL
         EXEC sp_executesql
           N'UPDATE lms.Course SET RequiresQuizPass = 1 WHERE CourseId = @c',
           N'@c uniqueidentifier', @c = @courseId`,
      { courseId },
    );
  }

  return {
    courseId,
    slug: seed.slug,
    versionId,
    versionNumber,
    status: outcome,
    lessonCount: seed.lessons.length,
    questionCount,
  };
}

// Maps each top-level category to a hand-authored SVG illustration in
// /public/images/courses/categories. The SVG file IS the asset — no external
// CDN, no per-tenant rewriting, and they ship in the standalone Next bundle.
function categoryHeroBlock(
  category: CourseSeed["category"],
  lessonTitle: string,
): SeedContentBlock {
  const file: Record<CourseSeed["category"], string> = {
    security: "/images/courses/categories/security.svg",
    productivity: "/images/courses/categories/productivity.svg",
    engineering: "/images/courses/categories/engineering.svg",
  };
  return {
    kind: "image",
    url: file[category],
    alt: `${lessonTitle} — ${category} lesson illustration`,
  };
}
