import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "./logging";

function harness(fail = false) {
  const calls: { text: string; params: Record<string, unknown> }[] = [];
  const lines: string[] = [];
  const logger = createLogger({
    execute: async (text, params) => {
      if (fail) throw new Error("Could not find stored procedure 'logging.usp_RecordError'.");
      calls.push({ text, params });
      return 1;
    },
    console: { error: (s: string) => lines.push(s) },
  });
  return { logger, calls, lines };
}

test("a service run calls usp_RecordServiceRun with the procedure's parameter names", async () => {
  const h = harness();
  await h.logger.recordServiceRun("lms-daily-digest", "PARTIAL", 1234.6, 9, "2 tenants failed", 2);
  await h.logger.recordServiceRun("lms-daily-digest", "SUCCESS", 10, 3);
  assert.match(h.calls[0]!.text, /^EXEC logging\.usp_RecordServiceRun @ServiceName = @ServiceName, @Status = @Status, @DurationMs = @DurationMs, @ItemsProcessed = @ItemsProcessed, @ErrorCount = @ErrorCount, @Message = @Message$/);
  assert.deepEqual(h.calls[0]!.params, { ServiceName: "lms-daily-digest", Status: "PARTIAL", DurationMs: 1235, ItemsProcessed: 9, ErrorCount: 2, Message: "2 tenants failed" });
  assert.deepEqual(h.calls[1]!.params, { ServiceName: "lms-daily-digest", Status: "SUCCESS", DurationMs: 10, ItemsProcessed: 3, ErrorCount: 0, Message: null });
  assert.deepEqual(h.lines, []);
});

test("an error calls usp_RecordError, cut to the columns' lengths, ERROR by default", async () => {
  const h = harness();
  await h.logger.recordError("lms-api", "x".repeat(5000), undefined, "y".repeat(9000));
  await h.logger.recordError("lms-api", "short", "WARNING");
  assert.match(h.calls[0]!.text, /^EXEC logging\.usp_RecordError @ServiceName = @ServiceName, @Message = @Message, @Severity = @Severity, @StackTrace = @StackTrace$/);
  assert.equal((h.calls[0]!.params.Message as string).length, 4000);
  assert.equal((h.calls[0]!.params.StackTrace as string).length, 8000);
  assert.equal(h.calls[0]!.params.Severity, "ERROR");
  assert.deepEqual(h.calls[1]!.params, { ServiceName: "lms-api", Message: "short", Severity: "WARNING", StackTrace: null });
});

test("when the write fails the record goes to the console and nothing is thrown", async () => {
  const h = harness(true);
  await h.logger.recordServiceRun("lms-daily-digest", "FAILURE", 5, 0, "mailbox missing", 1);
  await h.logger.recordError("lms-api", "boom", "CRITICAL", "at x");
  assert.deepEqual(h.lines, [
    "[logging] not saved: [lms-daily-digest] FAILURE in 5 ms, 0 items, 1 errors: mailbox missing",
    "[logging] not saved: [lms-api] CRITICAL: boom\nat x",
  ]);
});

test("a console that throws is swallowed too", async () => {
  const logger = createLogger({
    execute: async () => {
      throw new Error("down");
    },
    console: {
      error: () => {
        throw new Error("stdout closed");
      },
    },
  });
  await logger.recordError("lms-api", "boom");
});
