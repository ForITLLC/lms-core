import { z } from "zod";
import { canMarkExams } from "@/lib/auth/records-permissions";
import { noStoreJson, requireTenantRole, staffRouteFailure } from "@/lib/auth/staff-gate";
import { FEEDBACK_MAX_CHARS, REASON_MAX_CHARS, recordInstructorMark } from "@/lib/ai/grading/instructor";
import { recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVICE = "lms-ai-grading";

// An instructor marks a written answer (slice A5a; the marking queue page that
// posts here is A5b): `override` with their own score and a reason, or
// `confirm` the AI's mark by its gradeId. A role of the session's tenant that
// may mark exams (canMarkExams: staff, an instructor or a training manager);
// an attempt that isn't one of that tenant's learners' reads as not found.
// The answer carries the attempt's new scores, never the learner's answer.

const Id = z.string().uuid();

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("override"),
    attemptId: Id,
    questionId: Id,
    score: z.number().int().min(0),
    reason: z.string().max(REASON_MAX_CHARS).optional(),
    feedbackMd: z.string().max(FEEDBACK_MAX_CHARS).nullable().optional(),
  }).strict(),
  z.object({
    action: z.literal("confirm"),
    attemptId: Id,
    questionId: Id,
    gradeId: Id,
  }).strict(),
]);

const REFUSED = {
  no_reason: [400, "Give a reason for overriding the mark."],
  score_out_of_range: [400, "The score must be a whole number from 0 to the question's maximum."],
  not_found: [404, "Answer not found"],
  busy: [409, "The answer's marks changed while saving. Try again."],
} as const;

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  try {
    const gate = await requireTenantRole(canMarkExams);
    if (!gate.ok) return gate.response;
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) {
      return noStoreJson({ error: "Send an attemptId and questionId with either an override (score and reason) or a confirm (gradeId)." }, 400);
    }
    const mark = body.data.action === "override" ? { ...body.data, reason: body.data.reason ?? "" } : body.data;
    const result = await recordInstructorMark(gate.tenantId, gate.email, mark);
    if (!result.ok) {
      const [status, error] = REFUSED[result.reason];
      return noStoreJson({ error }, status);
    }
    await recordServiceRun(
      SERVICE,
      "SUCCESS",
      Date.now() - started,
      1,
      `${body.data.action} tenant=${gate.tenantId} attempt=${result.attempt.attemptId} grade=${result.gradeId}`,
    );
    return noStoreJson({ gradeId: result.gradeId, attempt: result.attempt });
  } catch (error) {
    return staffRouteFailure(SERVICE, error);
  }
}
