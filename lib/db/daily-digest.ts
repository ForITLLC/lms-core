import { query } from "@/lib/db";
import {
  listUpcomingForLearner,
  type UpcomingItem,
} from "@/lib/db/dashboard";
import {
  listOverdueForTenant,
  type OverdueItem,
} from "@/lib/db/overdue";
import { isServiceAccount } from "@/lib/service-account";

// Daily-digest payload assembly. The dashboard tier rules are the source of
// truth — Required + Upcoming come from the same helpers the page uses, so
// the email and the dashboard can never contradict each other.
//
// SUPPRESSION: a learner gets emailed only when they have ≥1 required item
// OR ≥1 upcoming item within `urgentWindowDays`. Quiet inboxes stay quiet —
// no "you're all caught up 🎉" daily spam.

const URGENT_WINDOW_DAYS_DEFAULT = 14;

export interface DigestLearnerRow {
  LearnerId: string;
  Email: string;
  DisplayName: string;
}

export interface DigestPayload {
  learnerId: string;
  email: string;
  displayName: string;
  required: OverdueItem[];
  upcoming: UpcomingItem[];
}

// Collects per-learner digest payloads for a tenant. Tenant-scoped at every
// join (Learner.TenantId, plus the helpers themselves are tenant-scoped).
// Suppression filters happen here so the route can just iterate + send.
export async function collectDailyDigest(
  tenantId: string,
  opts: { urgentWindowDays?: number } = {},
): Promise<DigestPayload[]> {
  const urgentWindow = opts.urgentWindowDays ?? URGENT_WINDOW_DAYS_DEFAULT;

  const [learners, allOverdue] = await Promise.all([
    query<DigestLearnerRow>(
      `SELECT CONVERT(varchar(64), LearnerId) AS LearnerId,
              Email, DisplayName
         FROM lms.Learner
        WHERE TenantId = @tenantId
          AND Status   = 'active'
        ORDER BY Email ASC`,
      { tenantId },
    ),
    listOverdueForTenant(tenantId),
  ]);

  const overdueByLearner = new Map<string, OverdueItem[]>();
  for (const it of allOverdue) {
    const bucket = overdueByLearner.get(it.learnerId) ?? [];
    bucket.push(it);
    overdueByLearner.set(it.learnerId, bucket);
  }

  const payloads: DigestPayload[] = [];
  for (const learner of learners) {
    // Defense-in-depth: existing Learner rows for service accounts (synced
    // before lib/graph.ts learned to filter them) must never receive the
    // digest. The Graph-side filter handles new syncs; this catches the
    // stragglers already in lms.Learner.
    if (isServiceAccount(learner.Email)) continue;
    const required = (overdueByLearner.get(learner.LearnerId) ?? []).sort(
      (a, b) => (a.dueDate?.getTime() ?? 0) - (b.dueDate?.getTime() ?? 0),
    );
    const upcoming = await listUpcomingForLearner(
      tenantId,
      learner.LearnerId,
    );
    const hasUrgentUpcoming = upcoming.some(
      (u) => u.daysUntilDue <= urgentWindow,
    );
    if (required.length === 0 && !hasUrgentUpcoming) continue;
    payloads.push({
      learnerId: learner.LearnerId,
      email: learner.Email,
      displayName: learner.DisplayName,
      required,
      upcoming,
    });
  }
  return payloads;
}
