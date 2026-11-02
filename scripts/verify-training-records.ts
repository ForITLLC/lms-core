#!/usr/bin/env tsx
import "dotenv/config";
import { queryOne } from "@/lib/db";
import { readChain } from "@/lib/db/training-records";
import { verifyChain } from "@/lib/records/chain";

// Walks one tenant's training records in Seq order and recomputes every hash
// (docs/plans/2026-10-29-training-records-design.md §3.1). Exit 0 when the
// chain is whole, 1 when it is broken, 2 on a usage or connection error.
// Reads only; prints counts, Seqs and hashes, never a person's details.
//
//   tsx scripts/verify-training-records.ts <tenant-id | tenant-slug>

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function tenantIdFor(arg: string): Promise<string | null> {
  const row = GUID.test(arg)
    ? await queryOne<{ TenantId: string }>(`SELECT CONVERT(varchar(36), TenantId) AS TenantId FROM lms.Tenant WHERE TenantId = @arg`, { arg })
    : await queryOne<{ TenantId: string }>(`SELECT CONVERT(varchar(36), TenantId) AS TenantId FROM lms.Tenant WHERE Slug = @arg`, { arg });
  return row ? row.TenantId.toLowerCase() : null;
}

async function main(): Promise<number> {
  const arg = process.argv[2]?.trim();
  if (!arg) {
    console.error("usage: tsx scripts/verify-training-records.ts <tenant-id | tenant-slug>");
    return 2;
  }
  const tenantId = await tenantIdFor(arg);
  if (!tenantId) {
    console.error(`no tenant '${arg}'`);
    return 2;
  }
  const { rows, head } = await readChain(tenantId);
  const verdict = verifyChain(rows, head);
  if (verdict.ok) {
    console.log(`ok: tenant ${tenantId}, ${verdict.count} records, head Seq ${verdict.headSeq}, hash ${verdict.headHash}`);
    return 0;
  }
  console.log(`BROKEN: tenant ${tenantId}, at Seq ${verdict.seq} (${verdict.reason}): ${verdict.detail}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("verify failed:", err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
