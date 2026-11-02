import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/db/apiKeys";

// Bearer-key gate for the public REST API (/api/v1). The credential is the
// lms_<…> key minted at /admin/integrations: sha256-matched against lms.ApiKey
// and resolved to (tenantId, appUserId). Every /api/v1 handler filters by the
// tenantId returned here — never by anything carried in the request. An
// owner-only key is refused (403 insufficient_scope) unless the endpoint passes
// allowOwnerOnly, and such an endpoint answers it only about the key's owner.

export interface ApiKeyContext {
  tenantId: string;
  appUserId: string;
  ownerOnly: boolean;
}

export type ApiKeyGate =
  | { ok: true; ctx: ApiKeyContext }
  | { ok: false; response: NextResponse };

function unauthorized(description: string): NextResponse {
  return NextResponse.json(
    { error: "invalid_token", status: 401, error_description: description },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Bearer realm="lms", error="invalid_token"',
      },
    },
  );
}

export function bearerFrom(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

function insufficientScope(): NextResponse {
  return NextResponse.json(
    { error: "insufficient_scope", status: 403, error_description: "This key reads only its owner's own learning summary" },
    {
      status: 403,
      headers: {
        "WWW-Authenticate": 'Bearer realm="lms", error="insufficient_scope"',
      },
    },
  );
}

export interface RequireApiKeyOptions {
  allowOwnerOnly?: boolean;
  authenticate?: typeof authenticateApiKey;
}

export async function requireApiKey(req: Request, options: RequireApiKeyOptions = {}): Promise<ApiKeyGate> {
  const token = bearerFrom(req);
  if (!token) {
    return { ok: false, response: unauthorized("No authorization provided") };
  }
  const ctx = await (options.authenticate ?? authenticateApiKey)(token);
  if (!ctx) {
    return { ok: false, response: unauthorized("Unknown or revoked API key") };
  }
  if (ctx.ownerOnly && options.allowOwnerOnly !== true) {
    return { ok: false, response: insufficientScope() };
  }
  return { ok: true, ctx };
}
