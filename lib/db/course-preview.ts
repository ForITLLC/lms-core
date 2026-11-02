import { queryOne } from "@/lib/db";
import { getDraft, loadOwnVersion, UnreadableDraftError } from "@/lib/db/course-drafts";
import { toDraftDoc, UnreadableVersionError } from "@/lib/builder/fork";
import type { DraftDoc } from "@/lib/schema/draft";

// What the author preview shows for one of the tenant's own courses: its draft,
// or with no draft open, the version learners see now. Read-only, and scoped by
// the session's tenant in every statement; never getCourseBySlug, which also
// resolves another tenant's subscribed or entitled course with its answer keys.

export type PreviewSource =
  | { kind: "draft"; slug: string; draftId: string; revision: number; doc: DraftDoc }
  | { kind: "published"; slug: string; versionId: string; doc: DraftDoc }
  | { kind: "nothing"; slug: string }
  | { kind: "unreadable"; slug: string | null; message: string };

export async function loadPreviewSource(tenantId: string, courseId: string): Promise<PreviewSource | null> {
  try {
    const draft = await getDraft(tenantId, courseId);
    if (draft) return { kind: "draft", slug: draft.slug, draftId: draft.draftId, revision: draft.revision, doc: draft.doc };
  } catch (error) {
    if (error instanceof UnreadableDraftError) return { kind: "unreadable", slug: null, message: error.message };
    throw error;
  }

  const course = await queryOne<{ Slug: string }>(
    `SELECT c.Slug FROM lms.Course c WHERE c.TenantId = @tenantId AND c.CourseId = @courseId`,
    { tenantId, courseId },
  );
  if (!course) return null;
  const content = await loadOwnVersion(tenantId, courseId);
  if (!content) return null;
  if (!content.versionId) return { kind: "nothing", slug: course.Slug };
  try {
    return { kind: "published", slug: course.Slug, versionId: content.versionId, doc: toDraftDoc(content) };
  } catch (error) {
    if (error instanceof UnreadableVersionError) return { kind: "unreadable", slug: course.Slug, message: error.message };
    throw error;
  }
}
