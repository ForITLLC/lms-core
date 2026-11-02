import { z } from "zod";
import { noStoreJson, requireTenantStaff, staffRouteFailure } from "@/lib/auth/staff-gate";
import { getVersionHistory } from "@/lib/db/course-versions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The published versions of one of the tenant's own courses, newest first.
// Read only: restoring an earlier version is not in the MVP (decision 6).

interface RouteParams {
  params: Promise<{ courseId: string }>;
}

const CourseId = z.string().uuid();

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const gate = await requireTenantStaff();
    if (!gate.ok) return gate.response;
    const id = CourseId.safeParse((await params).courseId);
    const history = id.success ? await getVersionHistory(gate.tenantId, id.data.toLowerCase()) : null;
    return history ? noStoreJson(history) : noStoreJson({ error: "Course not found" }, 404);
  } catch (error) {
    return staffRouteFailure("lms-author", error);
  }
}
