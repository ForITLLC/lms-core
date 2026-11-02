import { z } from "zod";
import { noStoreJson, staffRouteFailure } from "@/lib/auth/staff-gate";
import { listPersonnelLinks } from "@/lib/db/personnel-links";
import { readTenantLearner } from "@/lib/db/training-records";
import { canManagePersonnel } from "@/lib/auth/records-permissions";
import { RECORDS_SERVICE, requireRecordsRight } from "@/lib/records/gate";
import { currentLink, PersonnelBody, recordPersonnelLink } from "@/lib/records/personnel";
import { recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A learner's duty position, employee number, hire and leave dates and
// for-CrewRecords reference (slice R2a, lms.PersonnelLink). GET answers every
// row and the one in force today; POST adds a row, either from a date or
// superseding a row entered wrongly, with the reason. Rows are never edited
// or removed. Needs canManagePersonnel; a learner of another tenant is 404.

interface RouteParams {
  params: Promise<{ learnerId: string }>;
}

const LearnerId = z.string().uuid();

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const gate = await requireRecordsRight(canManagePersonnel);
    if (!gate.ok) return gate.response;
    const id = LearnerId.safeParse((await params).learnerId);
    if (!id.success) return noStoreJson({ error: "Learner not found" }, 404);
    const learner = await readTenantLearner(gate.tenantId, id.data.toLowerCase());
    if (!learner) return noStoreJson({ error: "Learner not found" }, 404);
    const links = await listPersonnelLinks(gate.tenantId, learner.learnerId);
    const today = new Date().toISOString().slice(0, 10);
    return noStoreJson({ learner, links, current: currentLink(links, today) });
  } catch (error) {
    return staffRouteFailure(RECORDS_SERVICE, error);
  }
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const started = Date.now();
  try {
    const gate = await requireRecordsRight(canManagePersonnel);
    if (!gate.ok) return gate.response;
    const id = LearnerId.safeParse((await params).learnerId);
    if (!id.success) return noStoreJson({ error: "Learner not found" }, 404);
    const body = PersonnelBody.safeParse(await req.json().catch(() => null));
    if (!body.success) {
      return noStoreJson({
        error: "The personnel details aren't complete.",
        issues: body.error.issues.map((i) => ({ field: i.path.join(".") || "personnel", message: i.message })),
      }, 422);
    }

    const result = await recordPersonnelLink(gate.tenantId, id.data.toLowerCase(), body.data, gate.email);
    switch (result.outcome) {
      case "not_found":
        return noStoreJson({ error: body.data.supersedesLinkId ? "Learner or row not found" : "Learner not found" }, 404);
      case "already_superseded":
        return noStoreJson({ error: "That row has been superseded already.", code: "already_superseded" }, 409);
      case "added":
        await recordServiceRun(
          RECORDS_SERVICE,
          "SUCCESS",
          Date.now() - started,
          1,
          `personnel.add tenant=${gate.tenantId} learner=${result.link.learnerId} link=${result.link.personnelLinkId}${result.link.supersedesLinkId ? ` supersedes=${result.link.supersedesLinkId}` : ""}`,
        );
        return noStoreJson({ link: result.link }, 201);
    }
  } catch (error) {
    return staffRouteFailure(RECORDS_SERVICE, error);
  }
}
