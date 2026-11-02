import { createCallbackHandler } from "@foritllc/auth";
import { authConfigServer } from "@/lib/auth-config-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCallbackHandler(authConfigServer);
