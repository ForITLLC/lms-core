import { randomUUID } from "node:crypto";
import { execute, query, queryOne } from "@/lib/db";
import { ensureUniqueSlug, isUniqueViolation, randomSlug, slugify } from "@/lib/db/course-slug";
import { applyDraftOps, type DraftOp } from "@/lib/builder/draft-ops";
import { toDraftDoc, UnreadableVersionError, type VersionContent } from "@/lib/builder/fork";
import { DraftDoc, type DraftLesson } from "@/lib/schema/draft";

// The course builder's drafts (docs/plans/2026-10-28-course-builder-mvp.md).
// Every statement is scoped by the session's tenant through lms.Course or
// lms.CourseDraft.TenantId: a course id from another tenant reads as missing.
// Nothing here writes lessons, blocks or quizzes; lib/db/course-publish.ts does.

export interface DraftRecord {
  courseId: string;
  draftId: string;
  slug: string;
  status: string;
  baseVersionId: string | null;
  revision: number;
  doc: DraftDoc;
  updatedAt: Date;
  updatedBy: string;
}

export interface AuthorCourseRow {
  CourseId: string;
  Title: string;
  Slug: string;
  Status: string;
  VersionNumber: number | null;
  PublishedAt: Date | null;
  DraftRevision: number | null;
  DraftUpdatedAt: Date | null;
  DraftUpdatedBy: string | null;
}

// A draft is named by its id and revision together: revisions restart at 1 for
// every new draft of a course, so a tab still holding an earlier draft must not
// match the next one.
export interface DraftRef {
  draftId: string;
  revision: number;
}

// A stored draft the schema no longer accepts, such as a block address that is
// no longer allowed. It can still be discarded by its id and revision.
export class UnreadableDraftError extends UnreadableVersionError {
  constructor(readonly draftId: string, readonly revision: number) {
    super("This draft holds something the course builder can no longer open. Discard it and open the course again.");
  }
}

export type EditResult =
  | { ok: true; draftId: string; revision: number; doc: DraftDoc }
  | { ok: false; reason: "not_found" | "conflict" | "invalid"; error?: string };

export async function listAuthorCourses(tenantId: string): Promise<AuthorCourseRow[]> {
  return query<AuthorCourseRow>(
    `SELECT LOWER(CONVERT(varchar(36), c.CourseId)) AS CourseId, c.Title, c.Slug, c.Status,
            cv.VersionNumber, cv.PublishedAt,
            d.Revision AS DraftRevision, d.UpdatedAt AS DraftUpdatedAt, d.UpdatedBy AS DraftUpdatedBy
       FROM lms.Course c
       LEFT JOIN lms.CourseVersion cv ON cv.VersionId = c.CurrentVersionId
       LEFT JOIN lms.CourseDraft d ON d.CourseId = c.CourseId AND d.TenantId = c.TenantId
      WHERE c.TenantId = @tenantId
      ORDER BY COALESCE(d.UpdatedAt, c.UpdatedAt) DESC`,
    { tenantId },
  );
}

// The AI authoring job a course is created for no longer belongs to this
// worker: its lease was taken, it isn't running, or it already has a course.
// Nothing was written.
export class IngestionNotHeldError extends Error {
  constructor() {
    super("The authoring job is no longer held by this worker; no course was created.");
  }
}

// A new course is a lms.Course row in 'draft' status with no version, and a
// draft that is empty or holds the lessons given (AI authoring starts one with
// its generated lessons). Learners see nothing of it until the first publish.
// Given the AI authoring job it is made for, the same transaction stamps the
// job's ResultCourseId, and only while that worker still holds the job and the
// job has no course yet: a crash can't leave a course the job doesn't know
// about, and a retry can't make a second one.
export async function createCourse(
  tenantId: string,
  by: string,
  input: {
    title: string;
    description?: string;
    category?: string | null;
    slug?: string;
    lessons?: DraftLesson[];
    ingestion?: { ingestionId: string; leaseToken: string };
  },
): Promise<{ courseId: string; slug: string }> {
  if (input.lessons?.some((lesson) => lesson.blocks.some((block) => block.kind === "package"))) {
    throw new Error("A new course can't start with a package block; package blocks come only from an imported package.");
  }
  const courseId = randomUUID();
  const base = slugify(input.slug || input.title);
  const doc = DraftDoc.parse({
    meta: { title: input.title, description: input.description ?? "", category: input.category ?? null },
    lessons: input.lessons ?? [],
  });
  const params = (slug: string) => ({
    courseId,
    tenantId,
    title: doc.meta.title,
    slug,
    description: doc.meta.description,
    category: doc.meta.category,
    by,
    doc: JSON.stringify(doc),
  });
  const rows = `INSERT INTO lms.Course (CourseId, TenantId, Title, Slug, Description, Status, Category, CreatedBy)
       VALUES (@courseId, @tenantId, @title, @slug, @description, 'draft', @category, @by);
       INSERT INTO lms.CourseDraft (CourseId, TenantId, BaseVersionId, DocJson, CreatedBy, UpdatedBy)
       VALUES (@courseId, @tenantId, NULL, @doc, @by, @by);`;
  const ingestion = input.ingestion;
  const insert = async (slug: string) => {
    if (!ingestion) {
      await execute(
        `SET XACT_ABORT ON;
       BEGIN TRANSACTION;
       ${rows}
       COMMIT TRANSACTION;`,
        params(slug),
      );
      return;
    }
    const result = await queryOne<{ Created: boolean | number }>(
      `SET XACT_ABORT ON;
       BEGIN TRANSACTION;
       IF EXISTS (SELECT 1 FROM lms.AssetIngestion WITH (UPDLOCK, HOLDLOCK)
                   WHERE IngestionId = @ingestionId AND TenantId = @tenantId AND LeaseToken = @leaseToken
                     AND Status = 'running' AND ResultCourseId IS NULL)
       BEGIN
       ${rows}
       UPDATE lms.AssetIngestion
          SET ResultCourseId = @courseId, UpdatedAt = SYSUTCDATETIME()
        WHERE IngestionId = @ingestionId AND TenantId = @tenantId AND LeaseToken = @leaseToken;
       COMMIT TRANSACTION;
       SELECT CAST(1 AS BIT) AS Created;
       END
       ELSE
       BEGIN
       COMMIT TRANSACTION;
       SELECT CAST(0 AS BIT) AS Created;
       END`,
      { ...params(slug), ingestionId: ingestion.ingestionId, leaseToken: ingestion.leaseToken },
    );
    if (!result?.Created) throw new IngestionNotHeldError();
  };
  const slug = await ensureUniqueSlug(tenantId, base);
  try {
    await insert(slug);
    return { courseId, slug };
  } catch (err) {
    // Another create took the slug between the check and the insert.
    if (!isUniqueViolation(err)) throw err;
    const retry = randomSlug(base);
    await insert(retry);
    return { courseId, slug: retry };
  }
}

export async function getDraft(tenantId: string, courseId: string): Promise<DraftRecord | null> {
  const row = await queryOne<{
    CourseId: string;
    DraftId: string;
    Slug: string;
    Status: string;
    BaseVersionId: string | null;
    Revision: number;
    DocJson: string;
    UpdatedAt: Date;
    UpdatedBy: string;
  }>(
    `SELECT CONVERT(varchar(36), d.CourseId) AS CourseId, CONVERT(varchar(36), d.DraftId) AS DraftId, c.Slug, c.Status,
            CONVERT(varchar(36), d.BaseVersionId) AS BaseVersionId,
            d.Revision, d.DocJson, d.UpdatedAt, d.UpdatedBy
       FROM lms.CourseDraft d
       JOIN lms.Course c ON c.CourseId = d.CourseId AND c.TenantId = d.TenantId
      WHERE d.TenantId = @tenantId AND d.CourseId = @courseId`,
    { tenantId, courseId },
  );
  if (!row) return null;
  const draftId = row.DraftId.toLowerCase();
  const doc = DraftDoc.safeParse(parseJson(row.DocJson));
  if (!doc.success) throw new UnreadableDraftError(draftId, row.Revision);
  return {
    courseId: row.CourseId.toLowerCase(),
    draftId,
    slug: row.Slug,
    status: row.Status,
    baseVersionId: row.BaseVersionId?.toLowerCase() ?? null,
    revision: row.Revision,
    doc: doc.data,
    updatedAt: row.UpdatedAt,
    updatedBy: row.UpdatedBy,
  };
}

// The course's draft, starting one from its current version when it has none.
// Two tabs opening together get the same draft: the insert is skipped when one
// already exists, and both read back whichever landed. If the version moves
// between the read and the insert (a seed or import published), it tries again
// from the new one.
export async function openDraft(tenantId: string, courseId: string, by: string): Promise<DraftRecord | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await getDraft(tenantId, courseId);
    if (existing) return existing;

    const content = await loadOwnVersion(tenantId, courseId);
    if (!content) return null;
    await execute(
      `INSERT INTO lms.CourseDraft (CourseId, TenantId, BaseVersionId, DocJson, CreatedBy, UpdatedBy)
       SELECT c.CourseId, c.TenantId, c.CurrentVersionId, @doc, @by, @by
         FROM lms.Course c
        WHERE c.TenantId = @tenantId AND c.CourseId = @courseId
          AND ${content.versionId ? "c.CurrentVersionId = @versionId" : "c.CurrentVersionId IS NULL"}
          AND NOT EXISTS (SELECT 1 FROM lms.CourseDraft d WITH (UPDLOCK, HOLDLOCK) WHERE d.CourseId = c.CourseId)`,
      { tenantId, courseId, versionId: content.versionId, doc: JSON.stringify(toDraftDoc(content)), by },
    );
    const opened = await getDraft(tenantId, courseId);
    if (opened) return opened;
  }
  throw new Error(`openDraft: course ${courseId} kept changing version while its draft was opened`);
}

// Writes a whole draft document over the revision it was edited from. A write
// against an older revision, or another draft, is a conflict: someone else
// saved or published in between. Only editDraft calls it, so the
// package-block rule in applyDraftOps holds.
async function writeDraft(
  tenantId: string,
  courseId: string,
  by: string,
  { draftId, revision }: DraftRef,
  doc: DraftDoc,
): Promise<{ ok: true; revision: number } | { ok: false; reason: "not_found" | "conflict" }> {
  const saved = await queryOne<{ Revision: number }>(
    `UPDATE d
        SET DocJson = @doc, Revision = d.Revision + 1, UpdatedBy = @by, UpdatedAt = SYSUTCDATETIME()
     OUTPUT inserted.Revision
       FROM lms.CourseDraft d
      WHERE d.TenantId = @tenantId AND d.CourseId = @courseId AND d.DraftId = @draftId AND d.Revision = @revision`,
    { tenantId, courseId, draftId, revision, by, doc: JSON.stringify(DraftDoc.parse(doc)) },
  );
  if (saved) return { ok: true, revision: saved.Revision };
  const current = await queryOne<{ Revision: number }>(
    `SELECT d.Revision FROM lms.CourseDraft d WHERE d.TenantId = @tenantId AND d.CourseId = @courseId`,
    { tenantId, courseId },
  );
  return { ok: false, reason: current ? "conflict" : "not_found" };
}

export async function editDraft(
  tenantId: string,
  courseId: string,
  by: string,
  ref: DraftRef,
  ops: DraftOp[],
): Promise<EditResult> {
  const draft = await getDraft(tenantId, courseId);
  if (!draft) return { ok: false, reason: "not_found" };
  if (draft.draftId !== ref.draftId || draft.revision !== ref.revision) return { ok: false, reason: "conflict" };
  const applied = applyDraftOps(draft.doc, ops);
  if (!applied.ok) return { ok: false, reason: "invalid", error: applied.error };
  const saved = await writeDraft(tenantId, courseId, by, ref, applied.doc);
  if (!saved.ok) return saved;
  return { ok: true, draftId: draft.draftId, revision: saved.revision, doc: applied.doc };
}

// Only the draft at the revision the author last saw is discarded, so a stale
// tab can't throw away a newer draft or edits saved since. It never parses the
// document, so an unreadable draft can still be discarded.
export async function discardDraft(
  tenantId: string,
  courseId: string,
  { draftId, revision }: DraftRef,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "conflict" }> {
  const removed = await execute(
    `DELETE FROM lms.CourseDraft
      WHERE TenantId = @tenantId AND CourseId = @courseId AND DraftId = @draftId AND Revision = @revision`,
    { tenantId, courseId, draftId, revision },
  );
  if (removed > 0) return { ok: true };
  const current = await queryOne<{ Revision: number }>(
    `SELECT d.Revision FROM lms.CourseDraft d WHERE d.TenantId = @tenantId AND d.CourseId = @courseId`,
    { tenantId, courseId },
  );
  return { ok: false, reason: current ? "conflict" : "not_found" };
}

// One of the tenant's own courses at a version (its current one by default),
// read straight from the content tables. Never getCourseBySlug: that also
// resolves subscribed and entitled courses, which belong to another tenant.
export async function loadOwnVersion(
  tenantId: string,
  courseId: string,
  versionId?: string,
): Promise<(VersionContent & { versionId: string | null }) | null> {
  const course = await queryOne<VersionContent["course"] & { CurrentVersionId: string | null }>(
    `SELECT c.Title, c.Description, c.Category, c.Tags, c.ScheduleKind, c.RecurrenceMonths, c.RequiresQuizPass,
            CONVERT(varchar(36), c.CurrentVersionId) AS CurrentVersionId
       FROM lms.Course c
      WHERE c.TenantId = @tenantId AND c.CourseId = @courseId`,
    { tenantId, courseId },
  );
  if (!course) return null;
  const { CurrentVersionId, ...meta } = course;
  const version = versionId ?? CurrentVersionId;
  if (!version) return { course: meta, versionId: null, lessons: [], blocks: [], quizzes: [], questions: [] };

  const params = { tenantId, courseId, versionId: version };
  const ownCourse = `JOIN lms.Course c ON c.CourseId = l.CourseId
      WHERE c.TenantId = @tenantId AND c.CourseId = @courseId AND l.VersionId = @versionId`;
  const [lessons, blocks, quizzes, questions] = await Promise.all([
    query<VersionContent["lessons"][number]>(
      `SELECT CONVERT(varchar(36), l.LessonId) AS LessonId, l.Title, l.OrderIndex, l.EstMinutes
         FROM lms.Lesson l ${ownCourse}`,
      params,
    ),
    query<VersionContent["blocks"][number]>(
      `SELECT CONVERT(varchar(36), b.BlockId) AS BlockId, CONVERT(varchar(36), b.LessonId) AS LessonId,
              b.OrderIndex, b.PayloadJson
         FROM lms.Block b JOIN lms.Lesson l ON l.LessonId = b.LessonId ${ownCourse}
          AND b.VersionId = @versionId`,
      params,
    ),
    query<VersionContent["quizzes"][number]>(
      `SELECT CONVERT(varchar(36), q.QuizId) AS QuizId, CONVERT(varchar(36), q.BlockId) AS BlockId, q.PassingScore, q.IsExam
         FROM lms.Quiz q JOIN lms.Block b ON b.BlockId = q.BlockId
         JOIN lms.Lesson l ON l.LessonId = b.LessonId ${ownCourse}
          AND q.VersionId = @versionId`,
      params,
    ),
    query<VersionContent["questions"][number]>(
      `SELECT CONVERT(varchar(36), qq.QuizId) AS QuizId, qq.OrderIndex, qq.PayloadJson
         FROM lms.QuizQuestion qq JOIN lms.Quiz q ON q.QuizId = qq.QuizId
         JOIN lms.Block b ON b.BlockId = q.BlockId
         JOIN lms.Lesson l ON l.LessonId = b.LessonId ${ownCourse}
          AND qq.VersionId = @versionId`,
      params,
    ),
  ]);
  return { course: meta, versionId: version.toLowerCase(), lessons, blocks, quizzes, questions };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
