export interface NotificationDeliveryFilter {
  recipient: string;
  start: Date;
  end: Date;
  limit: number;
}

export interface NotificationDelivery {
  tenantId: string;
  recipientEmail: string;
  digestDay: string;
  claimId: string;
  status: "claimed" | "sent" | "uncertain";
  windowStart: string;
  windowEnd: string;
  claimedAt: string;
  sentAt: string | null;
  hasError: boolean;
}

export interface NotificationServiceRun {
  runTimestamp: string;
  status: "SUCCESS" | "FAILURE";
  durationMs: number | null;
  itemsProcessed: number;
  sent: number | null;
  skipped: number | null;
  held: number | null;
}

export interface NotificationDeliveryResult {
  deliveries: NotificationDelivery[];
  truncated: boolean;
  service_runs: NotificationServiceRun[];
  service_runs_truncated: boolean;
  service_runs_coverage: "available" | "partial_unparseable" | "insufficient_role" | "backend_read_failed";
}

type Parsed = { ok: true; value: NotificationDeliveryFilter } | { ok: false; error: string };
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const dayMs = 86_400_000;

function utcDate(value: string): Date | null {
  if (!utcPattern.test(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1) return null;
  return date.toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z")) ? date : null;
}

export function parseNotificationDeliveryQuery(params: URLSearchParams): Parsed {
  const allowed = new Set(["recipient", "start", "end", "day", "limit"]);
  for (const name of params.keys()) {
    if (!allowed.has(name) || params.getAll(name).length !== 1)
      return { ok: false, error: "Unknown or repeated query parameter" };
  }
  const recipient = (params.get("recipient") ?? "").trim().toLowerCase();
  const [local = "", domain = ""] = recipient.split("@");
  if (recipient.length > 320 || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")
    || domain.split(".").some(label => label.length > 63 || label.startsWith("-") || label.endsWith("-"))
    || !/^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(recipient)
    || domain.includes(".."))
    return { ok: false, error: "Provide an explicit valid recipient email" };
  const rawLimit = params.get("limit") ?? "50";
  if (rawLimit.trim() !== rawLimit || !/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100)
    return { ok: false, error: "limit must be an integer from 1 to 100" };

  let start: Date | null;
  let end: Date | null;
  if (params.has("day")) {
    const day = params.get("day")!;
    if (params.has("start") || params.has("end") || !/^\d{4}-\d{2}-\d{2}$/.test(day))
      return { ok: false, error: "Use either day or start and end" };
    start = utcDate(`${day}T00:00:00Z`);
    end = start ? new Date(start.getTime() + dayMs) : null;
  } else {
    start = utcDate(params.get("start") ?? "");
    end = utcDate(params.get("end") ?? "");
  }
  if (!start || !end || end.getUTCFullYear() > 9999 || end <= start || end.getTime() - start.getTime() > dayMs)
    return { ok: false, error: "Provide valid UTC start/end (Z), increasing and at most 24 hours apart, or a valid UTC day" };
  return { ok: true, value: { recipient, start, end, limit: Number(rawLimit) } };
}

interface Dependencies {
  authenticate(req: Request): Promise<
    { ok: true; ctx: { tenantId: string; appUserId: string } } | { ok: false; response: Response }
  >;
  authorize(tenantId: string, appUserId: string, recipient: string): Promise<{ allowed: boolean; admin: boolean }>;
  read(tenantId: string, filter: NotificationDeliveryFilter, options: { includeServiceRuns: boolean }): Promise<NotificationDeliveryResult>;
  recordUnavailable(): Promise<void>;
}

const excludedCoverage = {
  errors: "not_tenant_correlatable",
  mailbox_delivery: "not_observed",
  apns: "not_instrumented",
  native_local_notifications: "not_observed",
} as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function createNotificationDeliveriesHandler(deps: Dependencies) {
  return async (req: Request): Promise<Response> => {
    let gate: Awaited<ReturnType<Dependencies["authenticate"]>>;
    try {
      gate = await deps.authenticate(req);
    } catch {
      await deps.recordUnavailable().catch(() => undefined);
      return json({ error: "data_unavailable", status: 503,
        error_description: "Notification delivery authorization is unavailable",
        coverage: { state: "unavailable", ledger: "unavailable", service_runs: "backend_read_failed", ...excludedCoverage } }, 503);
    }
    if (!gate.ok) {
      const headers = new Headers(gate.response.headers);
      headers.set("Cache-Control", "private, no-store");
      return new Response(gate.response.body, { status: gate.response.status, headers });
    }
    const parsed = parseNotificationDeliveryQuery(new URL(req.url).searchParams);
    if (!parsed.ok) return json({ error: "invalid_request", status: 400, error_description: parsed.error }, 400);
    const filter = parsed.value;
    const request = { tenantId: gate.ctx.tenantId, recipient: filter.recipient,
      start: filter.start.toISOString(), end: filter.end.toISOString(), limit: filter.limit };
    try {
      const access = await deps.authorize(gate.ctx.tenantId, gate.ctx.appUserId, filter.recipient);
      if (!access.allowed) return json({ error: "forbidden", status: 403,
        error_description: "An existing admin or the recipient's own API key is required" }, 403);
      const { service_runs_coverage, ...result } = await deps.read(gate.ctx.tenantId, filter, { includeServiceRuns: access.admin });
      if (service_runs_coverage === "backend_read_failed") await deps.recordUnavailable().catch(() => undefined);
      return json({ ...request, ...result, errors: [],
        coverage: { state: "partial", ledger: "available", service_runs: service_runs_coverage, ...excludedCoverage },
        interpretation: "sent means transport accepted and ledger finalized, not mailbox delivery. Empty results do not prove no notification. Service runs are tenant aggregates, not recipient delivery proof. Uncorrelatable shared errors are excluded. Ledger matches ClaimedAt or SentAt in the half-open UTC interval; use day to inspect earlier daily claims." });
    } catch {
      await deps.recordUnavailable().catch(() => undefined);
      return json({ ...request, error: "data_unavailable", status: 503,
        error_description: "Notification delivery records are unavailable",
        coverage: { state: "unavailable", ledger: "unavailable", service_runs: "backend_read_failed", ...excludedCoverage } }, 503);
    }
  };
}
