import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import { getUserPhoto } from "@/lib/graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Directory-avatar proxy. The browser can't call Microsoft Graph directly —
// this serves the user's AAD profile photo app-only (lib/graph.ts:getUserPhoto)
// to a signed-in caller. A user with no photo (very common) yields a 404 from
// Graph; we forward that as a 404 so <Avatar> falls back to an initials circle.
// Never returns 500: any failure collapses to 404 for the same fallback path.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ oid: string }> },
): Promise<Response> {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const { oid } = await params;
  const photo = await getUserPhoto(oid);
  if (!photo) {
    return new NextResponse(null, { status: 404 });
  }

  return new NextResponse(photo.bytes, {
    status: 200,
    headers: {
      "Content-Type": photo.contentType,
      "Cache-Control": "private, max-age=86400",
    },
  });
}
