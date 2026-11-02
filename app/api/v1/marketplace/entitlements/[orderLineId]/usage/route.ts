import { withApiLogging } from "@/lib/api/handler";
import { requireMarketplaceCaller } from "@/lib/api/marketplace/auth";
import { createEntitlementUsageHandler } from "@/lib/api/marketplace/usage";
import { getEntitlementUsage } from "@/lib/db/entitlement-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Next.js needs the sibling route's segment name, so `orderLineId` here holds an entitlementId (a uuid).
export const GET = withApiLogging("marketplace_get_usage", createEntitlementUsageHandler({
  authenticate: (req) => requireMarketplaceCaller(req, "Marketplace.Usage.Read"),
  getUsage: getEntitlementUsage,
}));
