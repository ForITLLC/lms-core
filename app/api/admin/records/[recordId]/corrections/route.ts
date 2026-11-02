import { z } from "zod";
import { noStoreJson, staffRouteFailure } from "@/lib/auth/staff-gate";
import { canCorrectRecords } from "@/lib/auth/records-permissions";
import { RECORDS_SERVICE, requireRecordsRight } from "@/lib/records/gate";
import { CorrectionBody, correctRecord, recordView } from "@/lib/records/corrections";
import { recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Corrects or voids a training record (slice R2a). The record is never
// changed: the correction is a new record naming it, with the reason and who
// made it. Only the record in force can be corrected; correcting an older one
// answers 409 with the one in force. Needs canCorrectRecords; a record of
// another tenant is 404.

interface RouteParams {
  params: Promise<{ recordId: string }>;
}

const RecordId = z.string().uuid();

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const started = Date.now();
  try {
    const gate = await requireRecordsRight(canCorrectRecords);
    if (!gate.ok) return gate.response;
    const id = RecordId.safeParse((await params).recordId);
    if (!id.success) return noStoreJson({ error: "Record not found" }, 404);
    const body = CorrectionBody.safeParse(await req.json().catch(() => null));
    if (!body.success) {
      return noStoreJson({
        error: "Send a reason, and either the changes or void: true.",
        issues: body.error.issues.map((i) => ({ field: i.path.join(".") || "correction", message: i.message })),
      }, 400);
    }

    const result = await correctRecord(gate.tenantId, id.data.toLowerCase(), body.data, gate.email);
    switch (result.outcome) {
      case "not_found":
        return noStoreJson({ error: "Record not found" }, 404);
      case "already_corrected":
        return noStoreJson({ error: "This record has been corrected already: correct the one in force.", code: "already_corrected", currentRecordId: result.currentRecordId }, 409);
      case "invalid":
        return noStoreJson({ error: "The correction can't be made.", issues: result.issues }, 422);
      case "corrected":
        await recordServiceRun(
          RECORDS_SERVICE,
          "SUCCESS",
          Date.now() - started,
          1,
          `record.correct tenant=${gate.tenantId} record=${result.record.correctsRecordId} by=${result.record.recordId}${body.data.void ? " void" : ""}`,
        );
        return noStoreJson({ record: recordView(result.record) }, 201);
    }
  } catch (error) {
    return staffRouteFailure(RECORDS_SERVICE, error);
  }
}
