import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/get-session";
import { resolveAppUserId } from "@/lib/db/users";
import { listApiKeys, mintApiKey, revokeApiKey } from "@/lib/db/apiKeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// LMS API key management for an admin/author (keys authenticate /api/v1). Keys are scoped to the caller:
// a user only ever sees, mints, or revokes their own. The plaintext key is
// returned exactly once, from POST. ownerOnly mints a key that reads only the
// minter's own learning summary (lib/api/bearer.ts).

const PostBody = z.object({ name: z.string().trim().min(1).max(128), ownerOnly: z.boolean().default(false) }).strict();

type StaffGate =
  | { ok: true; tenantId: string; appUserId: string }
  | { ok: false; response: NextResponse };

async function requireStaff(): Promise<StaffGate> {
  let session;
  try {
    session = await requireSessionUser();
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Unauthenticated" }, { status: 401 }) };
  }
  if (session.role !== "admin" && session.role !== "author") {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  if (!session.tenantId) {
    return { ok: false, response: NextResponse.json({ error: "No tenant" }, { status: 400 }) };
  }
  const appUserId = await resolveAppUserId(session.tenantId, session.email);
  if (!appUserId) {
    return { ok: false, response: NextResponse.json({ error: "Unknown app user" }, { status: 400 }) };
  }
  return { ok: true, tenantId: session.tenantId, appUserId };
}

export async function GET() {
  const gate = await requireStaff();
  if (!gate.ok) return gate.response;

  const keys = await listApiKeys(gate.tenantId, gate.appUserId);
  return NextResponse.json({ keys });
}

export async function POST(req: Request) {
  const gate = await requireStaff();
  if (!gate.ok) return gate.response;

  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid body" },
      { status: 400 },
    );
  }

  const key = await mintApiKey(gate.tenantId, gate.appUserId, body.name, body.ownerOnly);
  return NextResponse.json({ key }, { status: 201 });
}

export async function DELETE(req: Request) {
  const gate = await requireStaff();
  if (!gate.ok) return gate.response;

  const id = new URL(req.url).searchParams.get("id");
  if (!id || !z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "Missing or invalid ?id=" }, { status: 400 });
  }

  const revoked = await revokeApiKey(gate.tenantId, gate.appUserId, id);
  if (!revoked) {
    return NextResponse.json({ error: "Key not found or already revoked" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
