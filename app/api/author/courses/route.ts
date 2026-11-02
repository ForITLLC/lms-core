import { z } from "zod";
import { noStoreJson, requireTenantStaff, staffRouteFailure } from "@/lib/auth/staff-gate";
import { createCourse, listAuthorCourses } from "@/lib/db/course-drafts";
import { recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NewCourse = z
  .object({
    title: z.string().trim().min(1).max(256),
    description: z.string().max(8000).optional(),
    category: z.string().trim().max(32).nullable().optional(),
  })
  .strict();

export async function GET(): Promise<Response> {
  try {
    const gate = await requireTenantStaff();
    if (!gate.ok) return gate.response;
    return noStoreJson({ courses: await listAuthorCourses(gate.tenantId) });
  } catch (error) {
    return staffRouteFailure("lms-author", error);
  }
}

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  try {
    const gate = await requireTenantStaff();
    if (!gate.ok) return gate.response;
    const parsed = NewCourse.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return noStoreJson({ error: "Provide a title (and optionally a description and category)" }, 400);
    const created = await createCourse(gate.tenantId, gate.email, parsed.data);
    await recordServiceRun("lms-author", "SUCCESS", Date.now() - started, 1, `course.create tenant=${gate.tenantId} course=${created.courseId}`);
    return noStoreJson(created, 201);
  } catch (error) {
    return staffRouteFailure("lms-author", error);
  }
}
