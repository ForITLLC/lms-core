// Service-run and error records, written with logging.usp_RecordServiceRun and
// logging.usp_RecordError on the app's own sign-in, to the app's database or to
// LOGGING_SQL_SERVER / LOGGING_SQL_DATABASE when set. Where that write fails (a
// self-hosted database has no logging schema) the record goes to the console
// instead. A failed write never reaches the caller.
export type ServiceRunStatus = "SUCCESS" | "FAILURE" | "PARTIAL";
export type ErrorSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

type Execute = (text: string, params: Record<string, string | number | null>) => Promise<unknown>;

export interface LoggerDeps {
  execute?: Execute;
  console?: Pick<Console, "error">;
}

const RUN_SQL =
  "EXEC logging.usp_RecordServiceRun @ServiceName = @ServiceName, @Status = @Status, @DurationMs = @DurationMs, " +
  "@ItemsProcessed = @ItemsProcessed, @ErrorCount = @ErrorCount, @Message = @Message";
const ERROR_SQL =
  "EXEC logging.usp_RecordError @ServiceName = @ServiceName, @Message = @Message, @Severity = @Severity, @StackTrace = @StackTrace";

export function createLogger(deps: LoggerDeps = {}) {
  // Loaded on first write, so importing this module never loads the SQL driver.
  const execute: Execute = deps.execute ?? (async (text, params) => (await import("@/lib/db")).executeLogging(text, params));
  const out = deps.console ?? console;

  async function write(text: string, params: Record<string, string | number | null>, line: string) {
    try {
      await execute(text, params);
    } catch {
      try {
        out.error(`[logging] not saved: ${line}`);
      } catch {}
    }
  }

  async function recordServiceRun(
    serviceName: string,
    status: ServiceRunStatus,
    durationMs: number,
    itemsProcessed: number,
    message?: string,
    errorCount?: number,
  ): Promise<void> {
    const ms = Math.round(durationMs);
    await write(
      RUN_SQL,
      {
        ServiceName: serviceName,
        Status: status,
        DurationMs: ms,
        ItemsProcessed: itemsProcessed,
        ErrorCount: errorCount ?? 0,
        Message: message?.substring(0, 4000) || null,
      },
      `[${serviceName}] ${status} in ${ms} ms, ${itemsProcessed} items, ${errorCount ?? 0} errors${message ? `: ${message}` : ""}`,
    );
  }

  async function recordError(serviceName: string, message: string, severity: ErrorSeverity = "ERROR", stackTrace?: string): Promise<void> {
    await write(
      ERROR_SQL,
      {
        ServiceName: serviceName,
        Message: message.substring(0, 4000),
        Severity: severity,
        StackTrace: stackTrace?.substring(0, 8000) || null,
      },
      `[${serviceName}] ${severity}: ${message}${stackTrace ? `\n${stackTrace}` : ""}`,
    );
  }

  return { recordServiceRun, recordError };
}

const logger = createLogger();
export const recordServiceRun = logger.recordServiceRun;
export const recordError = logger.recordError;
