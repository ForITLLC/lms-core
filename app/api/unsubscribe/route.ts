import { createUnsubscribeRouteHandler, type UnsubscribeRouteHandlers } from "@/lib/vendor/mail";
import { recordError } from "@/lib/logging";
import { MAIL_PURPOSE, optOutStore, unsubscribeKeyringFromEnv, unsubscribePage } from "@/lib/email-optout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The signed token is the only credential: no session, no cookie (public path
// in lib/auth-config.ts). GET only asks; POST, from the page's button or the
// mail client's one-click, switches the mail off.
let handlers: UnsubscribeRouteHandlers | null = null;

function routeHandlers(): UnsubscribeRouteHandlers | null {
  if (handlers) return handlers;
  const keyring = unsubscribeKeyringFromEnv();
  if (!keyring) return null;
  handlers = createUnsubscribeRouteHandler({
    keyring,
    purpose: MAIL_PURPOSE,
    store: optOutStore(),
    page: unsubscribePage,
    onError: (error, context) => {
      void recordError("lms-unsubscribe", `${context.stage} failed for ${context.category}: ${error instanceof Error ? error.message : String(error)}`, "ERROR")
        .catch(() => undefined);
    },
  });
  return handlers;
}

function unavailable(): Response {
  return new Response("This link can't be used right now. Please try again later.", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
  });
}

async function handle(method: "GET" | "POST", request: Request): Promise<Response> {
  let route: UnsubscribeRouteHandlers | null;
  try {
    route = routeHandlers();
  } catch (error) {
    await recordError("lms-unsubscribe", `unsubscribe keyring is misconfigured: ${error instanceof Error ? error.message : String(error)}`, "ERROR")
      .catch(() => undefined);
    return unavailable();
  }
  if (!route) return unavailable();
  return method === "GET" ? route.GET(request) : route.POST(request);
}

export function GET(request: Request): Promise<Response> {
  return handle("GET", request);
}

export function POST(request: Request): Promise<Response> {
  return handle("POST", request);
}
