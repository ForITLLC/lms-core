import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// OpenAPI 3.1.0 discovery document for the LMS read API. The for-mcp gateway
// fetches this (manifest mechanism "openapi"), builds one tool per operation
// and mounts them under the forit_learn namespace — so operationIds are
// snake_case verbs and the mounted names come out as forit_learn_<operationId>,
// byte-identical to the tool names the retired embedded MCP server emitted.
// Served without auth (authConfig.publicPaths); the operations themselves
// require an lms_<…> bearer key.

const bearerAuth = [{ bearerAuth: [] }];

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const slugParam = {
  name: "slug",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "The course slug, as returned by list_courses.",
};

const spec = {
  openapi: "3.1.0",
  info: {
    title: "LMS API",
    version: "1.0.0",
    description:
      "Read-only view of one LMS tenant: courses, lessons, learners, per-course " +
      "progress, mandatory-training compliance, a recipient's learning summary and notification delivery diagnostics. Authenticate with an lms_<…> " +
      "bearer key minted at /admin/integrations; the key carries the tenant, so " +
      "no tenant argument is ever passed. No business data is changed; key-use timestamps and operational failure logs may be recorded.",
  },
  servers: [{ url: "/api/v1", description: "LMS v1 (relative to app root)" }],
  security: bearerAuth,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description:
          "Per-user LMS API key (lms_<prefix>_<secret>). sha256-matched against " +
          "lms.ApiKey and resolved to a single tenant.",
      },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error", "status", "error_description"],
        properties: {
          error: { type: "string", enum: ["invalid_token", "not_found", "invalid_request", "forbidden", "data_unavailable", "internal_error"] },
          status: { type: "integer" },
          error_description: { type: "string" },
        },
      },
      NotificationDeliveries: {
        type: "object",
        required: ["tenantId", "recipient", "start", "end", "limit", "deliveries", "truncated", "service_runs", "service_runs_truncated", "errors", "coverage", "interpretation"],
        properties: {
          tenantId: { type: "string", format: "uuid" },
          recipient: { type: "string", format: "email" },
          start: { type: "string", format: "date-time" },
          end: { type: "string", format: "date-time" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          truncated: { type: "boolean" },
          deliveries: {
            type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["tenantId", "recipientEmail", "digestDay", "claimId", "status", "windowStart", "windowEnd", "claimedAt", "sentAt", "hasError"],
              properties: {
                tenantId: { type: "string", format: "uuid" }, recipientEmail: { type: "string", format: "email" },
                digestDay: { type: "string", format: "date" }, claimId: { type: "string", format: "uuid" },
                status: { type: "string", enum: ["claimed", "sent", "uncertain"] },
                windowStart: { type: "string", format: "date-time" }, windowEnd: { type: "string", format: "date-time" },
                claimedAt: { type: "string", format: "date-time" }, sentAt: { type: ["string", "null"], format: "date-time" },
                hasError: { type: "boolean" },
              },
            },
          },
          service_runs: {
            type: "array", description: "Admin-only tenant aggregate runs, not recipient delivery proof.", items: {
              type: "object", additionalProperties: false,
              required: ["runTimestamp", "status", "durationMs", "itemsProcessed", "sent", "skipped", "held"],
              properties: {
                runTimestamp: { type: "string", format: "date-time" }, status: { type: "string", enum: ["SUCCESS", "FAILURE"] },
                durationMs: { type: ["integer", "null"], minimum: 0 }, itemsProcessed: { type: "integer", minimum: 0 },
                sent: { type: ["integer", "null"], minimum: 0 }, skipped: { type: ["integer", "null"], minimum: 0 },
                held: { type: ["integer", "null"], minimum: 0 },
              },
            },
          },
          service_runs_truncated: { type: "boolean" },
          errors: { type: "array", maxItems: 0, items: {} },
          coverage: {
            type: "object", required: ["state", "ledger", "service_runs", "errors", "mailbox_delivery", "apns", "native_local_notifications"],
            properties: {
              state: { const: "partial" }, ledger: { const: "available" },
              service_runs: { type: "string", enum: ["available", "partial_unparseable", "insufficient_role", "backend_read_failed"] },
              errors: { const: "not_tenant_correlatable" }, mailbox_delivery: { const: "not_observed" },
              apns: { const: "not_instrumented" }, native_local_notifications: { const: "not_observed" },
            },
          },
          interpretation: { type: "string" },
        },
      },
      CourseSummary: {
        type: "object",
        required: ["title", "slug", "status", "category"],
        properties: {
          title: { type: "string" },
          slug: { type: "string" },
          status: { type: "string", description: "draft | published | archived" },
          category: { type: ["string", "null"] },
        },
      },
      Lesson: {
        type: "object",
        required: ["title", "orderIndex", "estMinutes", "blockCount", "quizCount"],
        properties: {
          title: { type: "string" },
          orderIndex: { type: "integer" },
          estMinutes: { type: ["integer", "null"] },
          blockCount: { type: "integer" },
          quizCount: { type: "integer" },
        },
      },
      CourseDetail: {
        type: "object",
        required: ["title", "slug", "status", "lessons"],
        properties: {
          title: { type: "string" },
          slug: { type: "string" },
          status: { type: "string" },
          lessons: { type: "array", items: { $ref: "#/components/schemas/Lesson" } },
        },
      },
      Learner: {
        type: "object",
        required: ["learnerId", "displayName", "email", "status", "enrollments", "completions", "lastSeenAt"],
        properties: {
          learnerId: { type: "string", format: "uuid" },
          displayName: { type: "string" },
          email: { type: "string" },
          status: { type: "string" },
          enrollments: { type: "integer" },
          completions: { type: "integer" },
          lastSeenAt: {
            type: ["string", "null"],
            format: "date-time",
            description: "Most recent block completion — real training activity, not a sign-in.",
          },
        },
      },
      LearnerProgress: {
        type: "object",
        required: ["displayName", "email", "status", "pct", "completedAt"],
        properties: {
          displayName: { type: "string" },
          email: { type: "string" },
          status: { type: "string" },
          pct: { type: "integer", description: "Percent of the learner's pinned version completed." },
          completedAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      ProgressReport: {
        type: "object",
        required: ["course", "learnerCount", "completed", "learners"],
        properties: {
          course: {
            type: "object",
            required: ["title", "slug", "status"],
            properties: {
              title: { type: "string" },
              slug: { type: "string" },
              status: { type: "string" },
            },
          },
          learnerCount: { type: "integer" },
          completed: { type: "integer" },
          learners: { type: "array", items: { $ref: "#/components/schemas/LearnerProgress" } },
        },
      },
      ComplianceTotals: {
        type: "object",
        properties: {
          totalLearners: { type: "integer" },
          totalMandatoryCourses: { type: "integer" },
          totalMandatoryEnrollments: { type: "integer" },
          mandatoryCompletions: { type: "integer" },
          certificatesValid: { type: "integer" },
          certificatesExpired: { type: "integer" },
        },
      },
      CourseCompliance: {
        type: "object",
        properties: {
          title: { type: "string" },
          slug: { type: "string" },
          isMandatory: { type: "boolean" },
          totalEnrolled: { type: "integer" },
          completed: { type: "integer" },
          outstanding: { type: "integer" },
          certificatesValid: { type: "integer" },
          certificatesExpired: { type: "integer" },
        },
      },
      SummaryItem: {
        type: "object",
        required: ["id", "course_id", "course_slug", "course_title", "learner_id", "learner_name", "learner_email", "due_date", "occurred_at"],
        properties: {
          id: { type: "string" },
          course_id: { type: "string" },
          course_slug: { type: "string" },
          course_title: { type: "string" },
          learner_id: { type: "string" },
          learner_name: { type: "string" },
          learner_email: { type: "string" },
          due_date: { type: ["string", "null"], format: "date-time" },
          occurred_at: { type: ["string", "null"], format: "date-time" },
        },
      },
      SummarySection: {
        type: "object",
        required: ["overdue", "due", "completions", "new_assignments"],
        properties: {
          overdue: { type: "array", items: { $ref: "#/components/schemas/SummaryItem" } },
          due: { type: "array", items: { $ref: "#/components/schemas/SummaryItem" } },
          completions: { type: "array", items: { $ref: "#/components/schemas/SummaryItem" } },
          new_assignments: { type: "array", items: { $ref: "#/components/schemas/SummaryItem" } },
        },
      },
      SummaryCounts: {
        type: "object",
        required: ["overdue", "due", "completions", "new_assignments"],
        properties: {
          overdue: { type: "integer" },
          due: { type: "integer" },
          completions: { type: "integer" },
          new_assignments: { type: "integer" },
        },
      },
      LearningSummary: {
        type: "object",
        required: ["recipient", "generated_at", "window_start", "summary_url", "counts", "personal", "team"],
        properties: {
          recipient: { type: "string", format: "email" },
          generated_at: { type: "string", format: "date-time" },
          window_start: { type: "string", format: "date-time", description: "Completions and new assignments count from here (the last 24 hours)." },
          summary_url: { type: "string", format: "uri", description: "The recipient's summary page on the tenant's own host." },
          counts: {
            type: "object",
            required: ["personal", "team"],
            properties: {
              personal: { $ref: "#/components/schemas/SummaryCounts" },
              team: { oneOf: [{ $ref: "#/components/schemas/SummaryCounts" }, { type: "null" }] },
            },
          },
          personal: { $ref: "#/components/schemas/SummarySection" },
          team: {
            oneOf: [
              { allOf: [{ $ref: "#/components/schemas/SummarySection" }, { type: "object", required: ["scope"], properties: { scope: { type: "string", enum: ["manager", "admin"] } } }] },
              { type: "null" },
            ],
          },
        },
      },
      ComplianceSummary: {
        type: "object",
        required: ["totals", "courses"],
        properties: {
          totals: { $ref: "#/components/schemas/ComplianceTotals" },
          courses: { type: "array", items: { $ref: "#/components/schemas/CourseCompliance" } },
        },
      },
    },
  },
  paths: {
    "/learning-summary": {
      get: {
        operationId: "get_learning_summary",
        summary: "One recipient's due, overdue, completed and newly assigned training",
        description: "The feed the ForIT Daily email reads; LMS sends no summary email of its own. A tenant admin's key may read any recipient in the key's tenant; any other key only its owner's own email. An owner-only key (minted with ownerOnly: true) reads only its owner's own email whatever its owner's role, and every other /api/v1 operation refuses it with 403 insufficient_scope. The team section appears only for a manager or admin recipient. Unknown or repeated query parameters are rejected.",
        parameters: [
          { name: "recipient", in: "query", required: true, schema: { type: "string", format: "email", maxLength: 320 }, description: "The recipient's email, trimmed and lowercased." },
        ],
        responses: {
          "200": { description: "The recipient's learning summary; no-store.", content: { "application/json": { schema: { $ref: "#/components/schemas/LearningSummary" } } } },
          "400": errorResponse("Missing or invalid recipient, unknown or repeated query parameter"),
          "401": errorResponse("Missing, unknown or revoked API key"),
          "403": errorResponse("The key is neither a tenant admin's nor the recipient's own, or it reads only its owner's own summary and the recipient is someone else"),
          "503": errorResponse("Summary storage unavailable; generic error, no SQL text"),
        },
      },
    },
    "/notification-deliveries": {
      get: {
        operationId: "get_notification_deliveries",
        summary: "Inspect bounded notification ledger and tenant run evidence",
        description: "An existing AppUser admin may inspect a tenant recipient; other users may inspect only their own normalized email. Admins also receive allowlisted tenant aggregate run counts attributed through the key tenant's unique DB-resolved slug. Choose either day or start/end (positive half-open UTC interval, at most 24 hours). Ledger matches ClaimedAt or SentAt; use day for earlier daily claims. sent means transport acceptance, not mailbox delivery. Shared errors cannot be tenant-correlated and are excluded. Coverage is partial; no APNs/native local or mailbox delivery proof. Existing key-use timestamps and operational logging still apply.",
        parameters: [
          { name: "recipient", in: "query", required: true, schema: { type: "string", format: "email", maxLength: 320 }, description: "Explicit email, trimmed and lowercased; no recipient overrides or sends." },
          { name: "day", in: "query", schema: { type: "string", format: "date" }, description: "Whole UTC day YYYY-MM-DD; mutually exclusive with start/end." },
          { name: "start", in: "query", schema: { type: "string", format: "date-time" }, description: "Inclusive UTC timestamp, seconds and Z required, optional three-digit milliseconds. Requires end." },
          { name: "end", in: "query", schema: { type: "string", format: "date-time" }, description: "Exclusive UTC timestamp; greater than start, at most 24 hours apart." },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 }, description: "Bound for each evidence collection; truncation is explicit. Unknown/repeated parameters are rejected." },
        ],
        responses: {
          "200": { description: "Partial diagnostic evidence; no-store. Empty results never prove no send.", content: { "application/json": { schema: { $ref: "#/components/schemas/NotificationDeliveries" } } } },
          "400": errorResponse("Invalid recipient, UTC range/day, limit, unknown or repeated query parameter"),
          "401": errorResponse("Missing, unknown or revoked API key"),
          "403": errorResponse("Existing AppUser is neither admin nor the requested recipient"),
          "503": errorResponse("Authorization or ledger storage unavailable; generic error and unavailable coverage, no SQL/provider text"),
        },
      },
    },
    "/courses": {
      get: {
        operationId: "list_courses",
        summary: "List every course in the tenant",
        description:
          "Every course the tenant owns (including drafts) plus published shared " +
          "catalogue courses it subscribes to, with title, slug, status and category. " +
          "Call this first to discover slugs for get_course and get_progress.",
        responses: {
          "200": {
            description: "Course list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["courses"],
                  properties: {
                    courses: { type: "array", items: { $ref: "#/components/schemas/CourseSummary" } },
                  },
                },
              },
            },
          },
          "401": errorResponse("Missing, unknown or revoked API key"),
        },
      },
    },
    "/courses/{slug}": {
      get: {
        operationId: "get_course",
        summary: "Get one course's lessons",
        description:
          "One course's lessons (current published version) with per-lesson " +
          "estimated minutes, block count and quiz count.",
        parameters: [slugParam],
        responses: {
          "200": {
            description: "Course detail",
            content: { "application/json": { schema: { $ref: "#/components/schemas/CourseDetail" } } },
          },
          "401": errorResponse("Missing, unknown or revoked API key"),
          "404": errorResponse("No course with that slug in the tenant"),
        },
      },
    },
    "/courses/{slug}/progress": {
      get: {
        operationId: "get_progress",
        summary: "Per-learner completion rollup for one course",
        description:
          "Every enrolled learner's status and percent complete for the course, " +
          "plus learnerCount and completed totals. Use list_courses to find the slug.",
        parameters: [slugParam],
        responses: {
          "200": {
            description: "Progress report",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ProgressReport" } } },
          },
          "401": errorResponse("Missing, unknown or revoked API key"),
          "404": errorResponse("No course with that slug in the tenant"),
        },
      },
    },
    "/learners": {
      get: {
        operationId: "list_learners",
        summary: "List every learner in the tenant",
        description:
          "Every learner with enrollment and completion counts and their last " +
          "training activity (most recent block completion).",
        responses: {
          "200": {
            description: "Learner list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["learners"],
                  properties: {
                    learners: { type: "array", items: { $ref: "#/components/schemas/Learner" } },
                  },
                },
              },
            },
          },
          "401": errorResponse("Missing, unknown or revoked API key"),
        },
      },
    },
    "/compliance": {
      get: {
        operationId: "compliance_summary",
        summary: "Tenant-wide mandatory-training compliance",
        description:
          "Done vs outstanding mandatory training, per course and in total, " +
          "including valid and expired certificate counts.",
        responses: {
          "200": {
            description: "Compliance summary",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ComplianceSummary" } } },
          },
          "401": errorResponse("Missing, unknown or revoked API key"),
        },
      },
    },
  },
} as const;

export function GET() {
  return NextResponse.json(spec, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
