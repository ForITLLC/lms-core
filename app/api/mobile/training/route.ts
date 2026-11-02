import { NextResponse } from "next/server";
import { requireMobileLearner } from "@/lib/mobile/learner";
import { listOverdueForTenant } from "@/lib/db/overdue";
import { listOptionalForLearner, listUpcomingForLearner } from "@/lib/db/dashboard";
import { listAssignmentsForLearner } from "@/lib/db/assignments";
import { getProgressForLearner } from "@/lib/db/progress";
import { buildTraining } from "@/lib/mobile/training";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A year ahead, so the app can schedule its local due-date reminders from one
// fetch; the web dashboard's Upcoming tier shows the nearer 60 days.
const REMINDER_WINDOW_DAYS = 365;

export async function GET(): Promise<NextResponse> {
  const gate = await requireMobileLearner();
  if (!gate.ok) return gate.response;
  const { session, learner } = gate;
  const [allOverdue, upcoming, assignments, optional, progress] = await Promise.all([
    listOverdueForTenant(session.tenantId),
    listUpcomingForLearner(session.tenantId, learner.learnerId, { windowDays: REMINDER_WINDOW_DAYS }),
    listAssignmentsForLearner(session.tenantId, session.email),
    listOptionalForLearner(session.tenantId, learner.learnerId),
    getProgressForLearner(session.tenantId, learner.learnerId),
  ]);
  const training = buildTraining({
    overdue: allOverdue.filter((o) => o.learnerId === learner.learnerId),
    upcoming,
    assignments,
    optional,
    progress,
    now: new Date(),
  });
  return NextResponse.json({ generated_at: new Date().toISOString(), ...training });
}
