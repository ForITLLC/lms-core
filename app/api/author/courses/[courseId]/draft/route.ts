import { z } from "zod";
import { noStoreJson, requireTenantStaff, staffRouteFailure } from "@/lib/auth/staff-gate";
import { discardDraft, editDraft, getDraft, openDraft, UnreadableDraftError, type DraftRecord } from "@/lib/db/course-drafts";
import { DraftOps } from "@/lib/builder/draft-ops";
import { UnreadableVersionError } from "@/lib/builder/fork";
import { publishProblems } from "@/lib/schema/draft";
import { recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The builder's working copy of one of the tenant's own courses. A course id
// from another tenant, or not a course id at all, reads as not found.

interface RouteParams {
  params: Promise<{ courseId: string }>;
}

const CourseId = z.string().uuid();
const DraftId = z.string().uuid().transform((id) => id.toLowerCase());
const Edit = z.object({ draftId: DraftId, revision: z.number().int().min(1), ops: DraftOps }).strict();
const Discard = z.object({ draftId: DraftId, revision: z.string().regex(/^[1-9][0-9]{0,8}$/).transform(Number) });

const notFound = () => noStoreJson({ error: "Course or draft not found" }, 404);

function present(draft: DraftRecord) {
  return { draft, problems: publishProblems(draft.doc) };
}

// An unreadable draft answers with its id and revision, so it can be discarded.
async function failure(error: unknown): Promise<Response> {
  if (error instanceof UnreadableDraftError) {
    return noStoreJson({ error: error.message, code: "unreadable", draftId: error.draftId, revision: error.revision }, 422);
  }
  if (error instanceof UnreadableVersionError) return noStoreJson({ error: error.message, code: "unreadable" }, 422);
  return staffRouteFailure("lms-author", error);
}

async function courseIdOf(params: RouteParams["params"]): Promise<string | null> {
  const parsed = CourseId.safeParse((await params).courseId);
  return parsed.success ? parsed.data.toLowerCase() : null;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const gate = await requireTenantStaff();
    if (!gate.ok) return gate.response;
    const courseId = await courseIdOf(params);
    const draft = courseId && (await getDraft(gate.tenantId, courseId));
    return draft ? noStoreJson(present(draft)) : notFound();
  } catch (error) {
    return failure(error);
  }
}

// Opens the course for editing: its draft, or a new one copied from the
// version learners see now.
export async function POST(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const gate = await requireTenantStaff();
    if (!gate.ok) return gate.response;
    const courseId = await courseIdOf(params);
    if (!courseId) return notFound();
    const draft = await openDraft(gate.tenantId, courseId, gate.email);
    return draft ? noStoreJson(present(draft)) : notFound();
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const started = Date.now();
  try {
    const gate = await requireTenantStaff();
    if (!gate.ok) return gate.response;
    const courseId = await courseIdOf(params);
    if (!courseId) return notFound();
    const parsed = Edit.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return noStoreJson({ error: "Provide the draft id, its revision and a list of edits", code: "invalid" }, 400);
    const { draftId, revision, ops } = parsed.data;
    const result = await editDraft(gate.tenantId, courseId, gate.email, { draftId, revision }, ops);
    if (!result.ok) {
      if (result.reason === "not_found") return notFound();
      if (result.reason === "conflict") {
        return noStoreJson({ error: "Someone else saved this draft first. Reload it and make the change again.", code: "conflict" }, 409);
      }
      return noStoreJson({ error: result.error ?? "That edit can't be made", code: "invalid" }, 422);
    }
    await recordServiceRun("lms-author", "SUCCESS", Date.now() - started, parsed.data.ops.length, `draft.edit tenant=${gate.tenantId} course=${courseId} revision=${result.revision}`);
    return noStoreJson({ draftId: result.draftId, revision: result.revision, doc: result.doc, problems: publishProblems(result.doc) });
  } catch (error) {
    return failure(error);
  }
}

// DELETE ?draftId=…&revision=…: discards that draft at that revision only, so
// a stale tab can't discard a newer draft or edits saved since it loaded.
export async function DELETE(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const gate = await requireTenantStaff();
    if (!gate.ok) return gate.response;
    const courseId = await courseIdOf(params);
    if (!courseId) return notFound();
    const query = new URL(req.url).searchParams;
    const ref = Discard.safeParse({ draftId: query.get("draftId"), revision: query.get("revision") });
    if (!ref.success) return noStoreJson({ error: "Provide the draft id and revision to discard", code: "invalid" }, 400);
    const result = await discardDraft(gate.tenantId, courseId, ref.data);
    if (result.ok) return noStoreJson({ ok: true });
    if (result.reason === "conflict") {
      return noStoreJson({ error: "The draft changed after you last loaded it. Reload it before discarding.", code: "draft_conflict" }, 409);
    }
    return notFound();
  } catch (error) {
    return staffRouteFailure("lms-author", error);
  }
}
