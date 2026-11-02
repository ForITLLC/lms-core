import { z } from "zod";
import { noStoreJson, staffRouteFailure } from "@/lib/auth/staff-gate";
import { listTenantLearners, readLearnerRecords, readTenantLearner } from "@/lib/db/training-records";
import { canReadRecords, canWriteRecordKind, canWriteRecords } from "@/lib/auth/records-permissions";
import { RECORDS_SERVICE, requireRecordsRight } from "@/lib/records/gate";
import { currentRecords, isVoid, recordView } from "@/lib/records/corrections";
import { checkEntry, isManualKind, recordManualEntry } from "@/lib/records/manual";
import { recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The tenant's training records (slice R2a of docs/plans/2026-10-29-training-records-design.md).
// GET with no learner lists the tenant's learners, left ones included; with
// ?learnerId= it answers that learner's records in force, newest first: the
// newest row of each line of corrections, voided ones left out. POST enters
// a record by hand for one learner. GET needs canReadRecords and POST
// canWriteRecords with a kind the role may write (an instructor's are the
// training it runs or assesses), and only where the tenant's records are
// switched on.

const LearnerId = z.string().uuid();

export async function GET(req: Request): Promise<Response> {
  try {
    const gate = await requireRecordsRight(canReadRecords);
    if (!gate.ok) return gate.response;
    const raw = new URL(req.url).searchParams.get("learnerId");
    if (raw === null) return noStoreJson({ learners: await listTenantLearners(gate.tenantId) });
    const id = LearnerId.safeParse(raw);
    if (!id.success) return noStoreJson({ error: "Learner not found" }, 404);
    const learner = await readTenantLearner(gate.tenantId, id.data.toLowerCase());
    if (!learner) return noStoreJson({ error: "Learner not found" }, 404);
    const all = await readLearnerRecords(gate.tenantId, learner.learnerId);
    return noStoreJson({
      learner,
      records: currentRecords(all).map(recordView),
      voided: all.filter(isVoid).length,
    });
  } catch (error) {
    return staffRouteFailure(RECORDS_SERVICE, error);
  }
}

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  try {
    const gate = await requireRecordsRight(canWriteRecords);
    if (!gate.ok) return gate.response;
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return noStoreJson({ error: "Send the record as JSON." }, 400);
    const { learnerId, ...fields } = body as Record<string, unknown>;
    const id = LearnerId.safeParse(learnerId);
    if (!id.success) return noStoreJson({ error: "Learner not found" }, 404);
    const kind = fields.kind;
    if (typeof kind === "string" && isManualKind(kind) && !canWriteRecordKind(gate.role, kind)) {
      return noStoreJson({ error: `Only a training manager or an admin can enter a record of this kind (${kind}).`, code: "kind_not_allowed" }, 403);
    }
    const checked = checkEntry(fields);
    if (!checked.ok) return noStoreJson({ error: "The record isn't complete.", issues: checked.issues }, 422);

    const record = await recordManualEntry(gate.tenantId, id.data.toLowerCase(), checked.entry, gate.email);
    if (!record) return noStoreJson({ error: "Learner not found" }, 404);
    await recordServiceRun(
      RECORDS_SERVICE,
      "SUCCESS",
      Date.now() - started,
      1,
      `record.manual tenant=${gate.tenantId} learner=${record.learnerId} record=${record.recordId} kind=${record.kind}`,
    );
    return noStoreJson({ record: recordView(record) }, 201);
  } catch (error) {
    return staffRouteFailure(RECORDS_SERVICE, error);
  }
}
