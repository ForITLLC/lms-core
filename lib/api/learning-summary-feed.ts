import { NextResponse } from "next/server";
import type { ApiKeyGate } from "@/lib/api/bearer";
import { SUMMARY_CATEGORIES, type LearningSummary, type SummaryCategory, type SummarySection } from "@/lib/learning-summary";

// The ForIT Daily email takes a recipient's LMS items from here. LMS sends no summary email of its own.

export interface LearningSummaryFeed {
  summary: LearningSummary;
  summaryUrl: string;
}

export interface LearningSummaryFeedDeps {
  authenticate(req: Request): Promise<ApiKeyGate>;
  authorize(tenantId: string, appUserId: string, recipient: string): Promise<{ allowed: boolean; self: boolean }>;
  read(tenantId: string, recipient: string): Promise<LearningSummaryFeed>;
  recordUnavailable(): Promise<unknown>;
}

type Parsed = { ok: true; recipient: string } | { ok: false; error: string };

export function parseLearningSummaryQuery(params: URLSearchParams): Parsed {
  for (const name of params.keys()) {
    if (name !== "recipient" || params.getAll(name).length !== 1) return { ok: false, error: "Unknown or repeated query parameter" };
  }
  const recipient = (params.get("recipient") ?? "").trim().toLowerCase();
  if (recipient.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return { ok: false, error: "Provide one valid recipient email" };
  return { ok: true, recipient };
}

function failure(status: number, error: string, description: string): NextResponse {
  return NextResponse.json({ error, status, error_description: description }, { status, headers: { "Cache-Control": "no-store" } });
}

function counts(section: SummarySection): Record<SummaryCategory, number> {
  return Object.fromEntries(SUMMARY_CATEGORIES.map(category => [category, section[category].length])) as Record<SummaryCategory, number>;
}

export function createLearningSummaryFeedHandler(deps: LearningSummaryFeedDeps) {
  return async (req: Request): Promise<Response> => {
    const gate = await deps.authenticate(req);
    if (!gate.ok) return gate.response;
    const parsed = parseLearningSummaryQuery(new URL(req.url).searchParams);
    if (!parsed.ok) return failure(400, "invalid_request", parsed.error);
    let feed: LearningSummaryFeed;
    try {
      const verdict = await deps.authorize(gate.ctx.tenantId, gate.ctx.appUserId, parsed.recipient);
      if (gate.ctx.ownerOnly ? !verdict.self : !verdict.allowed)
        return failure(403, "forbidden", gate.ctx.ownerOnly
          ? "This key reads only its owner's own summary"
          : "Only a tenant admin's key or the recipient's own key may read this summary");
      feed = await deps.read(gate.ctx.tenantId, parsed.recipient);
    } catch {
      await deps.recordUnavailable().catch(() => undefined);
      return failure(503, "data_unavailable", "Learning summary unavailable");
    }
    const { summary, summaryUrl } = feed;
    return NextResponse.json({
      recipient: parsed.recipient,
      generated_at: summary.generated_at,
      window_start: summary.window_start,
      summary_url: summaryUrl,
      counts: { personal: counts(summary.personal), team: summary.team ? counts(summary.team) : null },
      personal: summary.personal,
      team: summary.team,
    }, { headers: { "Cache-Control": "no-store" } });
  };
}
