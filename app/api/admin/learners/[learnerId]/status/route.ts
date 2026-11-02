import { z } from "zod";
import { canMarkLeft } from "@/lib/auth/records-permissions";
import { noStoreJson, requireTenantRole, staffRouteFailure } from "@/lib/auth/staff-gate";
import { LEARNER_STATUSES, setLearnerStatus } from "@/lib/db/learner-status";
import { recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVICE = "lms-learners";

// Marks a learner of the session's own tenant as having left, or back to
// active (slice R1b of docs/plans/2026-10-29-training-records-design.md). A
// left learner is never deleted: their history and training records stay
// readable, and they get no new assignment, reminder, digest or summary.
// Each change writes an AuditEvent in the same transaction. Needs canMarkLeft; a
// learner of another tenant is 404, as if it didn't exist.

interface RouteParams {
  params: Promise<{ learnerId: string }>;
}

const LearnerId = z.string().uuid();
const Body = z.object({ status: z.enum(LEARNER_STATUSES) }).strict();

export async function PUT(req: Request, { params }: RouteParams): Promise<Response> {
  const started = Date.now();
  try {
    const gate = await requireTenantRole(canMarkLeft);
    if (!gate.ok) return gate.response;
    const id = LearnerId.safeParse((await params).learnerId);
    if (!id.success) return noStoreJson({ error: "Learner not found" }, 404);
    const learnerId = id.data.toLowerCase();
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) return noStoreJson({ error: "Send status as \"active\" or \"left\"." }, 400);

    const result = await setLearnerStatus(gate.tenantId, learnerId, body.data.status, gate.email);
    switch (result.outcome) {
      case "not_found":
        return noStoreJson({ error: "Learner not found" }, 404);
      case "other_status":
        return noStoreJson({ error: `This learner's status is ${result.status}, which can't be changed here.`, code: "other_status" }, 409);
      case "changed":
      case "unchanged":
        await recordServiceRun(
          SERVICE,
          "SUCCESS",
          Date.now() - started,
          result.outcome === "changed" ? 1 : 0,
          `learner.status tenant=${gate.tenantId} learner=${learnerId} ${result.was}->${result.status}`,
        );
        return noStoreJson({ learnerId, status: result.status, was: result.was, changed: result.outcome === "changed" });
    }
  } catch (error) {
    return staffRouteFailure(SERVICE, error);
  }
}
