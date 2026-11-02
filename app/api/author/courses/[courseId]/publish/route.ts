import { z } from "zod";
import { noStoreJson, requireTenantStaff, staffRouteFailure } from "@/lib/auth/staff-gate";
import { publishDraft } from "@/lib/db/course-publish";
import { UnreadableVersionError } from "@/lib/builder/fork";
import { recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ courseId: string }>;
}

const CourseId = z.string().uuid();
const Publish = z
  .object({
    draftId: z.string().uuid().transform((id) => id.toLowerCase()),
    revision: z.number().int().min(1),
    changeNote: z.string().max(1024).optional(),
  })
  .strict();

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const started = Date.now();
  try {
    const gate = await requireTenantStaff();
    if (!gate.ok) return gate.response;
    const id = CourseId.safeParse((await params).courseId);
    if (!id.success) return noStoreJson({ error: "Course or draft not found" }, 404);
    const courseId = id.data.toLowerCase();
    const parsed = Publish.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return noStoreJson({ error: "Provide the draft id and revision to publish", code: "invalid" }, 400);

    const { draftId, revision, changeNote } = parsed.data;
    const result = await publishDraft(gate.tenantId, courseId, gate.email, { draftId, revision }, changeNote);
    if (!result.ok) {
      switch (result.reason) {
        case "not_found":
          return noStoreJson({ error: "Course or draft not found" }, 404);
        case "draft_conflict":
          return noStoreJson({ error: "The draft changed after you last loaded it. Reload it and publish again.", code: "draft_conflict" }, 409);
        case "base_moved":
          return noStoreJson({ error: "A newer version of this course was published while you edited. Discard this draft and open the course again.", code: "base_moved" }, 409);
        case "not_publishable":
          return noStoreJson({ error: "The draft isn't ready to publish", code: "not_publishable", problems: result.problems }, 422);
      }
    }
    await recordServiceRun("lms-author", "SUCCESS", Date.now() - started, 1, `course.publish tenant=${gate.tenantId} course=${courseId} version=${result.versionNumber}`);
    return noStoreJson({ versionId: result.versionId, versionNumber: result.versionNumber });
  } catch (error) {
    if (error instanceof UnreadableVersionError) return noStoreJson({ error: error.message, code: "unreadable" }, 422);
    return staffRouteFailure("lms-author", error);
  }
}
