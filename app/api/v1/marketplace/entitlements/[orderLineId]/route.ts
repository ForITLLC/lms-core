import { withApiLogging } from "@/lib/api/handler";
import { requireMarketplaceCaller } from "@/lib/api/marketplace/auth";
import { createEntitlementGetHandler, createEntitlementPutHandler } from "@/lib/api/marketplace/entitlements";
import {
  buyerOwnsCourseSlug,
  findEntitledCourse,
  findEntitlement,
  insertEntitlement,
  resolveBuyerTenant,
  updateEntitlement,
} from "@/lib/db/entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const authenticate = (req: Request) => requireMarketplaceCaller(req, "Marketplace.Entitlements.Write");

export const PUT = withApiLogging("marketplace_put_entitlement", createEntitlementPutHandler({
  authenticate,
  findEntitlement,
  resolveBuyer: resolveBuyerTenant,
  findCourse: findEntitledCourse,
  buyerOwnsSlug: buyerOwnsCourseSlug,
  insertEntitlement,
  updateEntitlement,
}));

export const GET = withApiLogging("marketplace_get_entitlement", createEntitlementGetHandler({
  authenticate,
  findEntitlement,
}));
