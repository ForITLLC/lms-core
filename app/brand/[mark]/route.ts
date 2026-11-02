import { foritMark } from "@/lib/forit-brand";

export const runtime = "nodejs";

// Public: the app's profile menu and the browser tab load these without a session.
export async function GET(_req: Request, { params }: { params: Promise<{ mark: string }> }) {
  const mark = foritMark((await params).mark);
  if (!mark) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(mark.bytes), {
    headers: { "Content-Type": mark.contentType, "Cache-Control": "public, max-age=86400" },
  });
}
