import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/get-session";
import { isPlatformStaff } from "@/lib/auth/platform";
import { queryOne, execute } from "@/lib/db";
import {
  azureAddHostname,
  azureBindSsl,
  azureCreateCert,
  azureConfig,
  azureConfigured,
  getAzureToken,
  getVerificationId,
} from "@/lib/dns/azure";
import {
  cloudflareConfigured,
  cloudflareProxiedDefault,
  lmsHostname,
  txtVisibleOnGoogleDns,
  upsertCname,
  upsertTxt,
} from "@/lib/dns/cloudflare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Step {
  step: string;
  status: "success" | "skipped" | "error";
  detail: string;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  let session;
  try {
    session = await requireSessionUser();
  } catch {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  if (!(await isPlatformStaff(session))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { slug } = await params;
  const safeSlug = slug.toLowerCase().trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(safeSlug)) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  const tenant = await queryOne<{ TenantId: string; Slug: string }>(
    `SELECT TenantId, Slug FROM lms.Tenant WHERE Slug = @slug AND IsActive = 1`,
    { slug: safeSlug },
  );
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  }

  const hostname = lmsHostname(safeSlug);
  const txtName = `asuid.${hostname}`;
  const cnameTarget = `${azureConfig.app}.azurewebsites.net`;
  const steps: Step[] = [];

  if (!cloudflareConfigured()) {
    return NextResponse.json(
      {
        error: "Cloudflare not configured",
        detail:
          "Set CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN (scoped token, DNS Edit on forit.io) env vars on the App Service.",
      },
      { status: 500 },
    );
  }

  if (!azureConfigured()) {
    return NextResponse.json(
      {
        error: "Azure not configured",
        detail: "Set AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP and AZURE_APP_NAME on the App Service.",
      },
      { status: 500 },
    );
  }

  const azureToken = await getAzureToken();
  if (!azureToken) {
    return NextResponse.json(
      { error: "Azure auth failed — managed identity / service principal missing" },
      { status: 500 },
    );
  }

  let verificationId: string | null = null;
  try {
    verificationId = await getVerificationId(azureToken);
    if (!verificationId) throw new Error("verificationId missing");
    steps.push({
      step: "azure_verification_id",
      status: "success",
      detail: verificationId,
    });
  } catch (e) {
    steps.push({
      step: "azure_verification_id",
      status: "error",
      detail: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "Could not read App Service verification ID", steps }, { status: 500 });
  }

  const proxied = cloudflareProxiedDefault;
  try {
    const cname = await upsertCname(hostname, cnameTarget, { proxied, ttl: 300 });
    steps.push({
      step: "cf_cname",
      status: "success",
      detail: `${cname.created ? "created" : "updated"} ${hostname} -> ${cnameTarget} (proxied=${proxied})`,
    });
  } catch (e) {
    steps.push({
      step: "cf_cname",
      status: "error",
      detail: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "Cloudflare CNAME failed", steps }, { status: 502 });
  }

  try {
    const txt = await upsertTxt(txtName, verificationId, 300);
    steps.push({
      step: "cf_txt_asuid",
      status: "success",
      detail: `${txt.created ? "created" : "updated"} ${txtName}`,
    });
  } catch (e) {
    steps.push({
      step: "cf_txt_asuid",
      status: "error",
      detail: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "Cloudflare TXT failed", steps }, { status: 502 });
  }

  let propagated = false;
  for (let i = 0; i < 6; i++) {
    if (await txtVisibleOnGoogleDns(txtName)) {
      propagated = true;
      break;
    }
    if (i < 5) await new Promise((r) => setTimeout(r, 15000));
  }
  steps.push({
    step: "dns_propagation",
    status: propagated ? "success" : "error",
    detail: propagated
      ? "TXT visible on Google DNS"
      : "TXT not visible after 90s — Azure binding likely to fail; retry later",
  });

  const bind = await azureAddHostname(azureToken, hostname);
  steps.push({
    step: "azure_hostname_binding",
    status: bind.ok ? "success" : "error",
    detail: bind.detail,
  });
  if (!bind.ok) {
    return NextResponse.json({ message: "Hostname binding failed", hostname, steps }, { status: 207 });
  }

  let success = true;
  let thumbprint: string | undefined;

  if (proxied) {
    steps.push({
      step: "azure_cert",
      status: "skipped",
      detail: "Cloudflare proxied — public TLS terminates at Cloudflare; Azure cert not required",
    });
    steps.push({
      step: "azure_ssl_bind",
      status: "skipped",
      detail: "Cloudflare proxied — no Azure SSL binding needed",
    });
  } else {
    const cert = await azureCreateCert(azureToken, hostname);
    steps.push({
      step: "azure_cert",
      status: cert.ok ? "success" : "error",
      detail: cert.detail,
    });
    if (!cert.ok || !cert.thumbprint) {
      return NextResponse.json({ message: "Cert pending — may complete async", hostname, steps }, { status: 207 });
    }
    thumbprint = cert.thumbprint;

    const ssl = await azureBindSsl(azureToken, hostname, cert.thumbprint);
    steps.push({
      step: "azure_ssl_bind",
      status: ssl.ok ? "success" : "error",
      detail: ssl.detail,
    });
    success = ssl.ok;
  }

  if (success) {
    await execute(
      `UPDATE lms.Tenant SET DnsProvisionedAt = SYSUTCDATETIME(), CustomHostname = @hostname WHERE TenantId = @tenantId`,
      { hostname, tenantId: tenant.TenantId },
    );
  }

  return NextResponse.json(
    {
      message: success
        ? `✓ ${hostname} fully provisioned for ${safeSlug}${proxied ? " (Cloudflare-proxied)" : ""}`
        : "Provisioned with issues — see steps",
      hostname,
      proxied,
      thumbprint,
      steps,
    },
    { status: success ? 200 : 207 },
  );
}
