import { z } from "zod";
import { getSessionUser } from "@/lib/get-session";
import { noStoreJson, staffRouteFailure } from "@/lib/auth/staff-gate";
import { readOwnAttempt } from "@/lib/db/answer-grades";
import { listReviewRequests } from "@/lib/db/answer-reviews";
import { learnerMarks } from "@/lib/ai/grading/learner-marks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVICE = "lms-ai-grading";

// The marks on one of the signed-in learner's own quiz attempts (slice A5b),
// so the player can show a written answer's mark when it lands after submit.
// Statuses, marks and feedback only (lib/ai/grading/learner-marks.ts). Another
// learner's attempt, another tenant's, or not an id at all reads as not found.

interface RouteParams {
  params: Promise<{ id: string }>;
}

const AttemptId = z.string().uuid();
const NOT_FOUND = { error: "Attempt not found" };

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const session = await getSessionUser();
    if (!session) return noStoreJson({ error: "Unauthenticated" }, 401);
    if (!session.tenantId) return noStoreJson({ error: "No tenant" }, 400);
    const { id } = await params;
    if (!AttemptId.safeParse(id).success) return noStoreJson(NOT_FOUND, 404);
    const attempt = await readOwnAttempt(session.tenantId, session.email, id.toLowerCase());
    if (!attempt) return noStoreJson(NOT_FOUND, 404);
    const reviews = await listReviewRequests(session.tenantId, attempt.attemptId);
    return noStoreJson(learnerMarks(attempt, reviews));
  } catch (error) {
    return staffRouteFailure(SERVICE, error);
  }
}
