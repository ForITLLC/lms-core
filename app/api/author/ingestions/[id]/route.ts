import { after } from "next/server";
import { z } from "zod";
import { noStoreJson, requireTenantStaff, staffRouteFailure } from "@/lib/auth/staff-gate";
import { isDue, kickWorker } from "@/lib/ai/authoring/kick";
import { getIngestion, type IngestionRecord } from "@/lib/db/ingestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One AI authoring job of the session's own tenant: where it is, what it
// dropped, the model tokens it spent and the course it made. Another tenant's job, or not a job id at
// all, reads as not found. The job's work and options never leave the server:
// they hold the source's text. Reading a job that is due kicks the worker
// (lib/ai/authoring/kick.ts), so the progress page keeps its job moving.

interface RouteParams {
  params: Promise<{ id: string }>;
}

const IngestionId = z.string().uuid();

function present(job: IngestionRecord) {
  return {
    id: job.ingestionId,
    status: job.status,
    stage: job.stage,
    lessonsDone: job.lessonsDone,
    lessonsTotal: job.lessonsTotal,
    attempts: job.attempts,
    source: { kind: job.sourceKind, ref: job.sourceRef },
    warnings: job.warnings,
    usage: job.usage,
    courseId: job.courseId,
    error: job.error,
    retryAt: job.status === "queued" && job.attempts > 0 ? job.notBefore : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const gate = await requireTenantStaff();
    if (!gate.ok) return gate.response;
    const id = IngestionId.safeParse((await params).id);
    const job = id.success ? await getIngestion(gate.tenantId, id.data.toLowerCase()) : null;
    if (!job) return noStoreJson({ error: "Ingestion not found" }, 404);
    if (isDue(job)) after(kickWorker);
    return noStoreJson({ ingestion: present(job) });
  } catch (error) {
    return staffRouteFailure("lms-ai-authoring", error);
  }
}
