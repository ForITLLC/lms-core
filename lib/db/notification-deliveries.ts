import { query, queryOne } from "@/lib/db";
import type { NotificationDelivery, NotificationDeliveryFilter, NotificationDeliveryResult, NotificationServiceRun } from "@/lib/api/notification-deliveries";

interface DeliveryRow {
  DigestDay: string;
  ClaimId: string;
  Status: NotificationDelivery["status"];
  WindowStart: Date;
  WindowEnd: Date;
  ClaimedAt: Date;
  SentAt: Date | null;
  HasError: boolean;
}

export async function authorizeNotificationDeliveryRead(tenantId: string, appUserId: string, recipient: string) {
  const actor = await queryOne<{ Email: string; Role: string }>(
    `SELECT Email, Role FROM lms.AppUser WHERE TenantId = @tenantId AND AppUserId = @appUserId`,
    { tenantId, appUserId },
  );
  const admin = actor?.Role === "admin";
  const self = !!actor && actor.Email.trim().toLowerCase() === recipient;
  return { admin, self, allowed: !!actor && (admin || self) };
}

interface RunRow {
  RunTimestamp: Date;
  Status: string;
  DurationMs: number | null;
  ItemsProcessed: number;
  Message: string;
}

function projectRun(row: RunRow, prefix: string): NotificationServiceRun | null {
  if (typeof row.Message !== "string" || !row.Message.startsWith(prefix) || !["SUCCESS", "FAILURE"].includes(row.Status)
    || !Number.isSafeInteger(row.ItemsProcessed) || row.ItemsProcessed < 0
    || (row.DurationMs !== null && (!Number.isSafeInteger(row.DurationMs) || row.DurationMs < 0))) return null;
  const message = row.Message.slice(prefix.length);
  const match = /^sent=(0|[1-9]\d*) skipped=(0|[1-9]\d*) held=(0|[1-9]\d*)$/.exec(message);
  let counts: { sent: number | null; skipped: number | null; held: number | null };
  if (match) {
    if (match[0] !== message) return null;
    const sent = Number(match[1]);
    const skipped = Number(match[2]);
    const held = Number(match[3]);
    if (![sent, skipped, held].every(Number.isSafeInteger) || row.ItemsProcessed !== sent
      || row.Status !== (held > 0 ? "FAILURE" : "SUCCESS")) return null;
    counts = { sent, skipped, held };
  } else if (message === "summary failed" && row.Status === "FAILURE" && row.ItemsProcessed === 0) {
    counts = { sent: null, skipped: null, held: null };
  } else return null;
  return { runTimestamp: row.RunTimestamp.toISOString(), status: row.Status as "SUCCESS" | "FAILURE",
    durationMs: row.DurationMs, itemsProcessed: row.ItemsProcessed, ...counts };
}

// Raw Error/provider text must never cross this read boundary. Shared errors
// have no tenant correlation. Runs are admin-only tenant aggregates, not receipts.
export async function readNotificationDeliveries(tenantId: string, filter: NotificationDeliveryFilter,
  options: { includeServiceRuns: boolean }): Promise<NotificationDeliveryResult> {
  const rows = await query<DeliveryRow>(
    `SELECT TOP (@take) CONVERT(varchar(10), DigestDay, 23) AS DigestDay,
       CONVERT(varchar(64), ClaimId) AS ClaimId, Status, WindowStart, WindowEnd,
       ClaimedAt, SentAt, CAST(CASE WHEN Error IS NULL THEN 0 ELSE 1 END AS bit) AS HasError
     FROM lms.DigestDelivery
     WHERE TenantId = @tenantId AND RecipientEmail = @recipient
       AND ((ClaimedAt >= @start AND ClaimedAt < @end)
         OR (SentAt >= @start AND SentAt < @end))
     ORDER BY ClaimedAt, ClaimId`,
    { tenantId, recipient: filter.recipient, start: filter.start, end: filter.end, take: filter.limit + 1 },
  );
  const result: NotificationDeliveryResult = {
    truncated: rows.length > filter.limit,
    deliveries: rows.slice(0, filter.limit).map((row): NotificationDelivery => ({
      tenantId, recipientEmail: filter.recipient, digestDay: row.DigestDay,
      claimId: row.ClaimId, status: row.Status, windowStart: row.WindowStart.toISOString(),
      windowEnd: row.WindowEnd.toISOString(), claimedAt: row.ClaimedAt.toISOString(),
      sentAt: row.SentAt?.toISOString() ?? null, hasError: Boolean(row.HasError),
    })),
    service_runs: [], service_runs_truncated: false, service_runs_coverage: "insufficient_role",
  };
  if (!options.includeServiceRuns) return result;
  try {
    // Slug is UNIQUE in lms.Tenant and is resolved solely from the key tenant.
    const tenant = await queryOne<{ Slug: string }>(`SELECT Slug FROM lms.Tenant WHERE TenantId = @tenantId`, { tenantId });
    if (!tenant) throw new Error("Tenant context unavailable");
    const prefix = `tenant=${tenant.Slug} `;
    const runs = await query<RunRow>(
      `SELECT TOP (@take) RunTimestamp, Status, DurationMs, ItemsProcessed, Message
       FROM logging.ServiceHealth
       WHERE ServiceName = @serviceName AND LEFT(Message, LEN(@prefix + N'#') - 1) = @prefix
         AND RunTimestamp >= @start AND RunTimestamp < @end
       ORDER BY RunTimestamp, Id`,
      { tenantId, serviceName: "lms-daily-digest", prefix, start: filter.start, end: filter.end, take: filter.limit + 1 },
    );
    result.service_runs_truncated = runs.length > filter.limit;
    const page = runs.slice(0, filter.limit);
    result.service_runs = page.flatMap(row => { const run = projectRun(row, prefix); return run ? [run] : []; });
    result.service_runs_coverage = page.length === result.service_runs.length ? "available" : "partial_unparseable";
  } catch {
    result.service_runs_coverage = "backend_read_failed";
  }
  return result;
}
