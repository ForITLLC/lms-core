import { createAuthMiddleware } from "@foritllc/auth";
import { authConfig } from "@/lib/auth-config";

export default createAuthMiddleware(authConfig);

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
