import { NextResponse } from "next/server";
import type { EntitlementUsage } from "@/lib/db/entitlement-usage";
import type { MarketplaceCallerGate } from "./auth";
import { UUID } from "./catalogue";
import { marketplaceError } from "./errors";

// Usage counts, docs/contracts/marketplace-connection.md §5: aggregates only. A closed entitlement
// still answers with its counts; only an unknown id is 404.

export interface UsageBody {
  entitlementId: string;
  asOf: string;
  seats: number;
  assigned: number;
  started: number;
  completed: number;
  dueForRenewalByMonth: Record<string, number>;
}

// The contract's `2027-02-01T06:00:00Z`: UTC, to the second.
export function asOfStamp(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function toUsageBody(entitlementId: string, at: Date, usage: EntitlementUsage): UsageBody {
  return {
    entitlementId: entitlementId.toLowerCase(),
    asOf: asOfStamp(at),
    seats: usage.seats,
    assigned: usage.assigned,
    started: usage.started,
    completed: usage.completed,
    dueForRenewalByMonth: { ...usage.dueForRenewalByMonth },
  };
}

export interface UsageDeps {
  authenticate: (req: Request) => Promise<MarketplaceCallerGate>;
  getUsage(entitlementId: string, at: Date): Promise<EntitlementUsage | null>;
  now?: () => Date;
}

// The route sits under the §3 route's [orderLineId] segment, so this param holds an entitlementId.
export interface UsageContext {
  params: Promise<{ orderLineId: string }>;
}

export function createEntitlementUsageHandler(deps: UsageDeps) {
  const now = deps.now ?? (() => new Date());
  return async (req: Request, { params }: UsageContext): Promise<Response> => {
    const gate = await deps.authenticate(req);
    if (!gate.ok) return gate.response;
    const { orderLineId: entitlementId } = await params;
    if (!UUID.test(entitlementId)) return marketplaceError(400, "invalid_request", "entitlementId must be a uuid");
    const id = entitlementId.toLowerCase();
    const at = now();
    const usage = await deps.getUsage(id, at);
    if (!usage) return marketplaceError(404, "entitlement_not_found", `no entitlement ${id}`);
    return NextResponse.json(toUsageBody(id, at, usage));
  };
}
