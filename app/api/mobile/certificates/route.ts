import { NextResponse } from "next/server";
import { requireMobileLearner } from "@/lib/mobile/learner";
import { listCertificatesForLearner } from "@/lib/db/certificates";
import { listCompletionsForLearner } from "@/lib/db/progress";
import { apiBaseFor } from "@/lib/mobile/profile";
import { getTenantProfile } from "@/lib/db/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const gate = await requireMobileLearner();
  if (!gate.ok) return gate.response;
  const { session, learner } = gate;
  const [certs, completions, tenant] = await Promise.all([
    listCertificatesForLearner(learner.learnerId),
    listCompletionsForLearner(session.tenantId, learner.learnerId),
    getTenantProfile(session.tenantId),
  ]);
  const base = tenant ? apiBaseFor(tenant) : null;
  const now = Date.now();
  return NextResponse.json({
    certificates: certs
      .filter((c) => c.TenantId.toUpperCase() === session.tenantId.toUpperCase())
      .map((c) => ({
        serial_no: c.SerialNo,
        course_id: c.CourseId,
        course_title: c.CourseTitle,
        learner_name: c.LearnerName,
        issued_at: new Date(c.IssuedAt).toISOString(),
        expires_at: c.ExpiresAt ? new Date(c.ExpiresAt).toISOString() : null,
        expired: c.ExpiresAt ? new Date(c.ExpiresAt).getTime() < now : false,
        url: base ? `${base}/certificate/${encodeURIComponent(c.SerialNo)}` : null,
      })),
    completions,
  });
}
