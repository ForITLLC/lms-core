import { z } from "zod";
import { noStoreJson, staffRouteFailure } from "@/lib/auth/staff-gate";
import { readLearnerRecords, readTrainingRecord } from "@/lib/db/training-records";
import { canReadRecords } from "@/lib/auth/records-permissions";
import { RECORDS_SERVICE, requireRecordsRight } from "@/lib/records/gate";
import { correctionLine, recordView } from "@/lib/records/corrections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One training record's whole line of corrections, oldest first: the record
// as first entered, each correction with its reason and who made it, and the
// one in force last (slice R2a). Needs canReadRecords; a record of another
// tenant is 404, as if it didn't exist.

interface RouteParams {
  params: Promise<{ recordId: string }>;
}

const RecordId = z.string().uuid();

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const gate = await requireRecordsRight(canReadRecords);
    if (!gate.ok) return gate.response;
    const id = RecordId.safeParse((await params).recordId);
    if (!id.success) return noStoreJson({ error: "Record not found" }, 404);
    const record = await readTrainingRecord(gate.tenantId, id.data.toLowerCase());
    if (!record) return noStoreJson({ error: "Record not found" }, 404);
    const line = correctionLine(await readLearnerRecords(gate.tenantId, record.learnerId), record.recordId);
    return noStoreJson({ line: line.map(recordView), currentRecordId: line[line.length - 1]?.recordId ?? record.recordId });
  } catch (error) {
    return staffRouteFailure(RECORDS_SERVICE, error);
  }
}
