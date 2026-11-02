const CF_API = "https://api.cloudflare.com/client/v4";
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const LMS_APEX = process.env.LMS_APEX_DOMAIN ?? "learn.forit.io";

export const cloudflareProxiedDefault =
  (process.env.CLOUDFLARE_PROXIED ?? "true").toLowerCase() !== "false";

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
}

interface CfList<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

// Scoped token only (DNS Edit on forit.io). The account global API key is not
// accepted: it was exposed and rotated (for-Security task 908FF0A4, 2026-10-06).
function cfHeaders(): Record<string, string> {
  if (!CF_TOKEN) {
    throw new Error("Cloudflare auth missing: set CLOUDFLARE_API_TOKEN");
  }
  return {
    Authorization: `Bearer ${CF_TOKEN}`,
    "Content-Type": "application/json",
  };
}

export function cloudflareConfigured(): boolean {
  return Boolean(CF_ZONE_ID && CF_TOKEN);
}

export function lmsHostname(slug: string): string {
  return `${slug}.${LMS_APEX}`;
}

async function listRecords(name: string, type: string): Promise<CfRecord[]> {
  const url = `${CF_API}/zones/${CF_ZONE_ID}/dns_records?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetch(url, { headers: cfHeaders() });
  const data = (await res.json()) as CfList<CfRecord[]>;
  if (!data.success) {
    const msg = data.errors?.map((e) => `${e.code}:${e.message}`).join("; ") ?? "unknown";
    throw new Error(`Cloudflare list failed: ${msg}`);
  }
  return data.result;
}

async function createRecord(input: {
  type: "CNAME" | "TXT";
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
}): Promise<CfRecord> {
  const res = await fetch(`${CF_API}/zones/${CF_ZONE_ID}/dns_records`, {
    method: "POST",
    headers: cfHeaders(),
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as CfList<CfRecord>;
  if (!data.success) {
    const msg = data.errors?.map((e) => `${e.code}:${e.message}`).join("; ") ?? "unknown";
    throw new Error(`Cloudflare create failed: ${msg}`);
  }
  return data.result;
}

async function updateRecord(
  id: string,
  input: {
    type: "CNAME" | "TXT";
    name: string;
    content: string;
    ttl: number;
    proxied?: boolean;
  },
): Promise<CfRecord> {
  const res = await fetch(`${CF_API}/zones/${CF_ZONE_ID}/dns_records/${id}`, {
    method: "PUT",
    headers: cfHeaders(),
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as CfList<CfRecord>;
  if (!data.success) {
    const msg = data.errors?.map((e) => `${e.code}:${e.message}`).join("; ") ?? "unknown";
    throw new Error(`Cloudflare update failed: ${msg}`);
  }
  return data.result;
}

export async function upsertCname(
  hostname: string,
  target: string,
  opts: { proxied?: boolean; ttl?: number } = {},
): Promise<{ created: boolean; record: CfRecord }> {
  const existing = await listRecords(hostname, "CNAME");
  const desired = {
    type: "CNAME" as const,
    name: hostname,
    content: target,
    ttl: opts.ttl ?? 1,
    proxied: opts.proxied ?? cloudflareProxiedDefault,
  };
  const cur = existing[0];
  if (cur) {
    if (cur.content === target && cur.proxied === desired.proxied) {
      return { created: false, record: cur };
    }
    const updated = await updateRecord(cur.id, desired);
    return { created: false, record: updated };
  }
  const created = await createRecord(desired);
  return { created: true, record: created };
}

export async function upsertTxt(
  hostname: string,
  content: string,
  ttl = 300,
): Promise<{ created: boolean; record: CfRecord }> {
  const existing = await listRecords(hostname, "TXT");
  const desired = { type: "TXT" as const, name: hostname, content, ttl };
  const match = existing.find((r) => r.content === content);
  if (match) return { created: false, record: match };
  const first = existing[0];
  if (first) {
    const updated = await updateRecord(first.id, desired);
    return { created: false, record: updated };
  }
  const created = await createRecord(desired);
  return { created: true, record: created };
}

export async function txtVisibleOnGoogleDns(hostname: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=TXT`,
    );
    const data = (await res.json()) as { Answer?: { data: string }[] };
    return Boolean(data.Answer && data.Answer.length > 0);
  } catch {
    return false;
  }
}
