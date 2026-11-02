import { NextResponse } from "next/server";
import { recordError } from "@/lib/logging";

// Wraps a /api/v1 route handler so an unexpected failure is recorded to
// logging.usp_RecordError (service "lms-api") and surfaced as a 500 in the
// same {error, status, error_description} envelope the 401/404 paths use —
// the gateway relays that body to the tool caller instead of an HTML stack.

type Handler<C> = (req: Request, context: C) => Promise<Response>;

export function withApiLogging<C>(operation: string, handler: Handler<C>): Handler<C> {
  return async (req, context) => {
    try {
      return await handler(req, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordError("lms-api", `${operation}: ${message}`, "ERROR").catch(() => undefined);
      return NextResponse.json(
        { error: "internal_error", status: 500, error_description: `${operation} failed` },
        { status: 500 },
      );
    }
  };
}
