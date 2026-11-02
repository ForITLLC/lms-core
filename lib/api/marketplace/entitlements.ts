import { NextResponse } from "next/server";
import { z } from "zod";
import type {
  BuyerTenant,
  EntitledCourse,
  EntitlementInsert,
  EntitlementUpdate,
  StoredEntitlement,
} from "@/lib/db/entitlements";
import type { MarketplaceCallerGate } from "./auth";
import { TENANT_SLUG, UUID } from "./catalogue";
import { marketplaceError } from "./errors";

// Seat intake, docs/contracts/marketplace-connection.md §3. decidePut holds every PUT rule as a pure
// function of the body and what the database holds; the handlers only read, write and answer.

const ORDER_LINE = /^[A-Za-z0-9._:-]{1,128}$/;
const BAD_ORDER_LINE = "orderLineId must be 1-128 characters of A-Z, a-z, 0-9 and . _ : -";
const MAX_SEATS = 100_000;

export interface EntitlementBody {
  entitlementId: string;
  orderLineId: string;
  tenantSlug: string;
  courseId: string;
  versionId: string;
  seats: number;
  seatsAssigned: number;
  accessUntil: string | null;
  status: "active" | "closed";
}

export function toEntitlementBody(e: StoredEntitlement): EntitlementBody {
  return {
    entitlementId: e.EntitlementId.toLowerCase(),
    orderLineId: e.OrderLineId,
    tenantSlug: e.TenantSlug,
    courseId: e.CourseId.toLowerCase(),
    versionId: e.VersionId.toLowerCase(),
    seats: e.Seats,
    seatsAssigned: e.SeatsAssigned,
    accessUntil: e.AccessUntil,
    status: e.Status,
  };
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return year >= 1 && days !== undefined && day >= 1 && day <= days;
}

const uuid = z.string().regex(UUID, "must be a uuid").transform((id) => id.toLowerCase());

const PutBody = z
  .object({
    tenantSlug: z.string().regex(TENANT_SLUG, "must be a tenant slug"),
    courseId: uuid,
    versionId: uuid,
    seats: z.number().int().min(0).max(MAX_SEATS),
    accessUntil: z.string().refine(isCalendarDate, "must be a calendar date YYYY-MM-DD").nullable(),
  })
  .strict();

export interface PutInput {
  orderLineId: string;
  tenantSlug: string;
  courseId: string;
  versionId: string;
  seats: number;
  accessUntil: string | null;
}

export type ParsedPut = { ok: true; input: PutInput } | { ok: false; description: string };

export function parsePutBody(orderLineId: string, body: unknown): ParsedPut {
  if (!ORDER_LINE.test(orderLineId)) return { ok: false, description: BAD_ORDER_LINE };
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, description: "body must be a JSON object" };
  }
  const parsed = PutBody.safeParse(body);
  if (!parsed.success) {
    const description = parsed.error.issues
      .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
      .join("; ");
    return { ok: false, description };
  }
  return { ok: true, input: { orderLineId, ...parsed.data } };
}

export interface PutState {
  existing: StoredEntitlement | null;
  buyer: BuyerTenant | null;
  course: EntitledCourse | null;
  slugConflict: boolean;
}

export interface Refusal {
  kind: "refuse";
  status: 400 | 404 | 409 | 422;
  code: string;
  description: string;
  extra?: Record<string, unknown>;
}

export type PutDecision =
  | { kind: "answer"; entitlement: StoredEntitlement }
  | Refusal
  | { kind: "insert"; row: EntitlementInsert }
  | { kind: "update"; change: EntitlementUpdate };

function refuse(status: Refusal["status"], code: string, description: string, extra?: Record<string, unknown>): Refusal {
  return { kind: "refuse", status, code, description, extra };
}

function belowAssigned(seatsAssigned: number): Refusal {
  return refuse(409, "seats_below_assigned", `${seatsAssigned} seats are assigned; unassign before lowering seats`, {
    seatsAssigned,
  });
}

// Each step answers before the next is checked. The order is the contract's: an order line's buyer
// and course are checked before anything else, and a closed entitlement stays closed.
export function decidePut(input: PutInput, state: PutState): PutDecision {
  const { existing, buyer, course } = state;

  if (existing) {
    const storedCourse = existing.CourseId.toLowerCase();
    if (existing.TenantSlug.toLowerCase() !== input.tenantSlug || storedCourse !== input.courseId) {
      const held = `tenant "${existing.TenantSlug}" on course ${storedCourse}`;
      return refuse(409, "order_line_mismatch", `order line ${existing.OrderLineId} is ${held}`, {
        tenantSlug: existing.TenantSlug,
        courseId: storedCourse,
      });
    }
    if (existing.Status === "closed") {
      if (input.seats === 0) return { kind: "answer", entitlement: existing };
      return refuse(409, "entitlement_closed", `order line ${existing.OrderLineId} is closed; a new purchase is a new order line`);
    }
  }

  if (!existing) {
    if (!buyer) return refuse(404, "tenant_not_found", `no active tenant "${input.tenantSlug}"`);
    if (!course) return refuse(404, "course_not_found", `no course ${input.courseId} with version ${input.versionId}`);
    if (!(course.Listable && course.VersionServed)) {
      return refuse(422, "course_not_listable", `course ${input.courseId} is not listed at version ${input.versionId}`);
    }
    if (state.slugConflict) {
      return refuse(409, "slug_conflict", `tenant "${buyer.Slug}" has its own course with slug "${course.Slug}"`);
    }
    if (input.seats === 0) return refuse(400, "invalid_request", "a new order line needs seats above 0");
    return {
      kind: "insert",
      row: {
        orderLineId: input.orderLineId,
        tenantId: buyer.TenantId,
        courseId: input.courseId,
        versionId: input.versionId,
        seats: input.seats,
        accessUntil: input.accessUntil,
      },
    };
  }

  // The line was bound to its buyer at purchase, so a refund still lands after that tenant is
  // deactivated, and after the publisher unlists the course unless the version changes.
  if (!course) return refuse(404, "course_not_found", `no course ${input.courseId} with version ${input.versionId}`);
  const versionChanged = existing.VersionId.toLowerCase() !== input.versionId;
  if (versionChanged && !(course.Listable && course.VersionServed)) {
    return refuse(422, "course_not_listable", `course ${input.courseId} is not listed at version ${input.versionId}`);
  }

  if (existing.Seats === input.seats && !versionChanged && existing.AccessUntil === input.accessUntil) {
    return { kind: "answer", entitlement: existing };
  }
  if (input.seats < existing.SeatsAssigned) return belowAssigned(existing.SeatsAssigned);
  return {
    kind: "update",
    change: {
      entitlementId: existing.EntitlementId,
      tenantId: existing.TenantId,
      versionId: input.versionId,
      seats: input.seats,
      accessUntil: input.accessUntil,
    },
  };
}

type Authenticate = (req: Request) => Promise<MarketplaceCallerGate>;

export interface EntitlementGetDeps {
  authenticate: Authenticate;
  findEntitlement(orderLineId: string): Promise<StoredEntitlement | null>;
}

export interface EntitlementPutDeps extends EntitlementGetDeps {
  resolveBuyer(slug: string): Promise<BuyerTenant | null>;
  findCourse(courseId: string, versionId: string): Promise<EntitledCourse | null>;
  buyerOwnsSlug(tenantId: string, slug: string, courseId: string): Promise<boolean>;
  insertEntitlement(row: EntitlementInsert): Promise<boolean>;
  updateEntitlement(change: EntitlementUpdate): Promise<boolean>;
}

export interface EntitlementContext {
  params: Promise<{ orderLineId: string }>;
}

function entitlementResponse(e: StoredEntitlement, status: 200 | 201): Response {
  return NextResponse.json(toEntitlementBody(e), { status });
}

async function readState(deps: EntitlementPutDeps, input: PutInput): Promise<PutState> {
  const [existing, buyer, course] = await Promise.all([
    deps.findEntitlement(input.orderLineId),
    deps.resolveBuyer(input.tenantSlug),
    deps.findCourse(input.courseId, input.versionId),
  ]);
  const slugConflict = buyer && course ? await deps.buyerOwnsSlug(buyer.TenantId, course.Slug, course.CourseId) : false;
  return { existing, buyer, course, slugConflict };
}

async function reread(deps: EntitlementPutDeps, orderLineId: string): Promise<StoredEntitlement> {
  const entitlement = await deps.findEntitlement(orderLineId);
  if (!entitlement) throw new Error(`order line ${orderLineId} was written but cannot be read`);
  return entitlement;
}

function answer(decision: Extract<PutDecision, { kind: "answer" }> | Refusal): Response {
  if (decision.kind === "answer") return entitlementResponse(decision.entitlement, 200);
  return marketplaceError(decision.status, decision.code, decision.description, decision.extra);
}

// A write that loses a race is decided once more on a fresh read: a concurrent create of the same
// order line turns into the retry or mismatch answer, and a guarded UPDATE that changed nothing
// sees whatever assignment or close got there first.
async function put(deps: EntitlementPutDeps, input: PutInput): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const decision = decidePut(input, await readState(deps, input));
    if (decision.kind === "answer" || decision.kind === "refuse") return answer(decision);
    if (decision.kind === "insert" && (await deps.insertEntitlement(decision.row))) {
      return entitlementResponse(await reread(deps, input.orderLineId), 201);
    }
    if (decision.kind === "update" && (await deps.updateEntitlement(decision.change))) {
      return entitlementResponse(await reread(deps, input.orderLineId), 200);
    }
    if (attempt === 2) {
      if (decision.kind === "insert") throw new Error(`order line ${input.orderLineId} exists but cannot be read`);
      const current = await reread(deps, input.orderLineId);
      return answer(belowAssigned(current.SeatsAssigned));
    }
  }
}

export function createEntitlementPutHandler(deps: EntitlementPutDeps) {
  return async (req: Request, { params }: EntitlementContext): Promise<Response> => {
    const gate = await deps.authenticate(req);
    if (!gate.ok) return gate.response;
    const { orderLineId } = await params;
    const parsed = parsePutBody(orderLineId, await req.json().catch(() => undefined));
    if (!parsed.ok) return marketplaceError(400, "invalid_request", parsed.description);
    return put(deps, parsed.input);
  };
}

export function createEntitlementGetHandler(deps: EntitlementGetDeps) {
  return async (req: Request, { params }: EntitlementContext): Promise<Response> => {
    const gate = await deps.authenticate(req);
    if (!gate.ok) return gate.response;
    const { orderLineId } = await params;
    if (!ORDER_LINE.test(orderLineId)) return marketplaceError(400, "invalid_request", BAD_ORDER_LINE);
    const entitlement = await deps.findEntitlement(orderLineId);
    if (!entitlement) return marketplaceError(404, "entitlement_not_found", `no entitlement for order line ${orderLineId}`);
    return entitlementResponse(entitlement, 200);
  };
}
