import { z } from "zod";
import { getSessionUser } from "@/lib/get-session";
import { noStoreJson, staffRouteFailure } from "@/lib/auth/staff-gate";
import { requestAnswerReview } from "@/lib/db/answer-reviews";
import { REVIEW_NOTE_MAX_CHARS } from "@/lib/ai/grading/written-answer";
import { recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVICE = "lms-ai-grading";

// A learner asks an instructor to look again at the mark on one of their own
// written answers (slice A5b), once per answer, with an optional note. The
// request puts the answer back in the staff marking queue and writes the
// AuditEvent quiz.grade.review_requested in the same transaction. Another
// learner's or tenant's answer reads as not found.

const Id = z.string().uuid();

const Body = z.object({
  attemptId: Id,
  questionId: Id,
  note: z.string().max(REVIEW_NOTE_MAX_CHARS).nullable().optional(),
}).strict();

const REFUSED = {
  not_found: [404, "Answer not found"],
  already: [409, "You've already asked your instructor to look at this answer again."],
  not_marked: [409, "This answer hasn't been marked yet. Your instructor will mark it."],
} as const;

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  try {
    const session = await getSessionUser();
    if (!session) return noStoreJson({ error: "Unauthenticated" }, 401);
    if (!session.tenantId) return noStoreJson({ error: "No tenant" }, 400);
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) {
      return noStoreJson({ error: `Send an attemptId and questionId, and a note of up to ${REVIEW_NOTE_MAX_CHARS} characters if you like.` }, 400);
    }
    const { outcome, requestId } = await requestAnswerReview(session.tenantId, session.email, {
      attemptId: body.data.attemptId,
      questionId: body.data.questionId,
      note: body.data.note?.trim() || null,
    });
    if (outcome !== "requested") {
      const [status, error] = REFUSED[outcome];
      return noStoreJson({ error }, status);
    }
    await recordServiceRun(
      SERVICE,
      "SUCCESS",
      Date.now() - started,
      1,
      `review tenant=${session.tenantId} attempt=${body.data.attemptId.toLowerCase()} request=${requestId}`,
    );
    return noStoreJson({ review: "open", requestId }, 201);
  } catch (error) {
    return staffRouteFailure(SERVICE, error);
  }
}
