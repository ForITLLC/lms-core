import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/lib/db";
import { countActiveItems, insertDrillItems, recentItemPrompts } from "@/lib/db/drill";
import { BATCH_SIZE, generateBatch } from "@/lib/drill/generate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BATCHES = 2;

// Tops a tenant's reasoning bank up to ?target= active items (default 60)
// in batches of ten, at most two batches per request — Azure's front door
// times out around 230s, so callers loop until `after` reaches `target`
// (drill-seed.yml does this). Bearer-protected by CRON_SECRET; the
// slug picks the tenant so one call never touches another tenant's bank.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const params = new URL(req.url).searchParams;
  const slug = params.get("slug");
  const target = Math.min(500, Math.max(1, Number(params.get("target") ?? 60) || 60));
  if (!slug) return NextResponse.json({ ok: false, error: "missing ?slug=" }, { status: 400 });

  const tenant = await queryOne<{ TenantId: string }>(
    `SELECT CONVERT(varchar(64), TenantId) AS TenantId FROM lms.Tenant WHERE Slug = @slug AND IsActive = 1`,
    { slug },
  );
  if (!tenant) return NextResponse.json({ ok: false, error: "unknown tenant" }, { status: 404 });

  const before = await countActiveItems(tenant.TenantId);
  let inserted = 0;
  const errors: string[] = [];
  for (let b = 0; b < MAX_BATCHES && before + inserted < target; b++) {
    const need = Math.min(BATCH_SIZE, target - before - inserted);
    try {
      const used = await recentItemPrompts(tenant.TenantId);
      const items = await generateBatch(need, used);
      inserted += await insertDrillItems(
        tenant.TenantId,
        items.map((it) => ({
          category: it.category,
          difficulty: it.difficulty,
          payload: {
            kind: it.kind,
            promptMd: it.promptMd,
            choices: it.choices,
            correctChoiceId: it.correctChoiceId,
            explanationMd: it.explanationMd,
          },
        })),
      );
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      if (errors.length >= 2) break;
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    slug,
    target,
    before,
    inserted,
    after: before + inserted,
    errors,
  });
}
