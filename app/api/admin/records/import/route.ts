import { noStoreJson, staffRouteFailure } from "@/lib/auth/staff-gate";
import { canImportRecords } from "@/lib/auth/records-permissions";
import { RECORDS_SERVICE, requireRecordsRight } from "@/lib/records/gate";
import { IMPORT_COLUMNS, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, runImport } from "@/lib/records/import";
import { recordError, recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Imports paper and spreadsheet training records from a CSV file sent as the
// body (slice R2a; lib/records/import.ts). ?dryRun=1 checks every row and
// writes nothing. A real import writes nothing unless every row is good, and
// running the same file again writes only the rows not yet written. Needs
// canImportRecords, and only where the tenant's records are switched on.

const CSV_TYPES = ["text/csv", "text/plain", "application/csv", "application/vnd.ms-excel"];

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  try {
    const gate = await requireRecordsRight(canImportRecords);
    if (!gate.ok) return gate.response;
    const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!CSV_TYPES.includes(type)) return noStoreJson({ error: "Send the file as text/csv." }, 415);
    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > MAX_IMPORT_BYTES) return noStoreJson({ error: `The file is over ${MAX_IMPORT_BYTES / 1_000_000} MB.` }, 413);
    const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

    const result = await runImport(gate.tenantId, await req.text(), { dryRun, recordedBy: gate.email });
    switch (result.outcome) {
      case "refused":
        return noStoreJson({ outcome: result.outcome, error: result.error, columns: Object.keys(IMPORT_COLUMNS), maxRows: MAX_IMPORT_ROWS }, 422);
      case "invalid":
        return noStoreJson({ ...result, error: "Nothing was imported: fix the rows listed and send the file again." }, 422);
      case "dry_run":
        return noStoreJson(result);
      case "imported":
        await recordServiceRun(
          RECORDS_SERVICE,
          "SUCCESS",
          Date.now() - started,
          result.written,
          `record.import tenant=${gate.tenantId} import=${result.importId} rows=${result.rows} written=${result.written} already=${result.alreadyWritten}`,
        );
        return noStoreJson(result);
      case "stopped": {
        const message = result.error instanceof Error ? result.error.message : String(result.error);
        await recordError(
          RECORDS_SERVICE,
          `record.import stopped tenant=${gate.tenantId} import=${result.importId} row=${result.stoppedAtRow} written=${result.written}: ${message}`,
          "ERROR",
        ).catch(() => undefined);
        return noStoreJson({
          outcome: result.outcome,
          importId: result.importId,
          rows: result.rows,
          written: result.written,
          stoppedAtRow: result.stoppedAtRow,
          error: `The import stopped at row ${result.stoppedAtRow} after writing ${result.written} rows. Send the same file again to write the rest.`,
        }, 500);
      }
    }
  } catch (error) {
    return staffRouteFailure(RECORDS_SERVICE, error);
  }
}
