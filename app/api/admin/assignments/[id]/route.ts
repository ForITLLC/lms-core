import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/get-session";
import { deleteAssignment } from "@/lib/db/assignments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  let session;
  try {
    session = await requireSessionUser();
  } catch {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  if (session.role !== "admin" && session.role !== "author") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!session.tenantId) {
    return NextResponse.json({ error: "No tenant" }, { status: 400 });
  }

  const { id } = await params;
  const removed = await deleteAssignment(session.tenantId, id);
  if (!removed) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
