import { createLoginHandler } from "@foritllc/auth";
import { authConfig } from "@/lib/auth-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createLoginHandler(authConfig);
