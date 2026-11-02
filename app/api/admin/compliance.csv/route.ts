import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import { getDefaultCurriculum } from "@/lib/db/curriculum";
import { getMandatoryCompletionSummary } from "@/lib/db/reporting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvEscape(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(req: Request) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (session.role !== "admin" && session.role !== "author") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const tenantId = session.tenantId;
  if (!tenantId) {
    return NextResponse.json({ error: "no tenant" }, { status: 400 });
  }

  const url = new URL(req.url);
  let curriculumId = url.searchParams.get("curriculum") ?? undefined;
  if (!curriculumId) {
    const def = await getDefaultCurriculum(tenantId);
    curriculumId = def?.curriculumId;
  }

  const rows = await getMandatoryCompletionSummary(tenantId, curriculumId);
  const header = [
    "courseId",
    "title",
    "category",
    "isMandatory",
    "totalEnrolled",
    "completed",
    "pending",
    "completionPct",
    "certIssued",
    "certExpired",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    const pct = r.totalEnrolled > 0 ? Math.round((r.completed / r.totalEnrolled) * 100) : 0;
    lines.push(
      [
        r.courseId,
        csvEscape(r.title),
        csvEscape(r.category),
        r.isMandatory ? "true" : "false",
        r.totalEnrolled,
        r.completed,
        r.pending,
        pct,
        r.certIssued,
        r.certExpired,
      ].join(","),
    );
  }
  const body = lines.join("\n") + "\n";
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="compliance-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}
