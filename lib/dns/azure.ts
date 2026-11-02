const AZURE_SUB = process.env.AZURE_SUBSCRIPTION_ID || "";
const AZURE_RG = process.env.AZURE_RESOURCE_GROUP || "";
const AZURE_APP = process.env.AZURE_APP_NAME || "";
const AZURE_PLAN = process.env.AZURE_APP_PLAN || "";
const AZURE_LOCATION = process.env.AZURE_LOCATION || "Central US";

export const azureConfig = {
  sub: AZURE_SUB,
  rg: AZURE_RG,
  app: AZURE_APP,
  plan: AZURE_PLAN,
  location: AZURE_LOCATION,
};

// The managed-certificate path (CLOUDFLARE_PROXIED=false) also needs AZURE_APP_PLAN.
export function azureConfigured(): boolean {
  return Boolean(AZURE_SUB && AZURE_RG && AZURE_APP);
}

export async function getAzureToken(): Promise<string | null> {
  const msiEndpoint = process.env.IDENTITY_ENDPOINT;
  const msiHeader = process.env.IDENTITY_HEADER;

  if (msiEndpoint && msiHeader) {
    try {
      const res = await fetch(
        `${msiEndpoint}?api-version=2019-08-01&resource=https://management.azure.com/`,
        { headers: { "X-IDENTITY-HEADER": msiHeader } },
      );
      if (res.ok) {
        const data = (await res.json()) as { access_token: string };
        return data.access_token;
      }
    } catch {
      /* fall through to service principal */
    }
  }

  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const tenantId = process.env.AZURE_TENANT_ID;
  if (!clientId || !clientSecret || !tenantId) return null;

  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://management.azure.com/.default",
      }),
    },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export async function getVerificationId(token: string): Promise<string | null> {
  const res = await fetch(
    `https://management.azure.com/subscriptions/${AZURE_SUB}/resourceGroups/${AZURE_RG}/providers/Microsoft.Web/sites/${AZURE_APP}?api-version=2023-01-01`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    properties?: { customDomainVerificationId?: string };
  };
  return data.properties?.customDomainVerificationId ?? null;
}

export async function azureAddHostname(
  token: string,
  domain: string,
): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(
    `https://management.azure.com/subscriptions/${AZURE_SUB}/resourceGroups/${AZURE_RG}/providers/Microsoft.Web/sites/${AZURE_APP}/hostNameBindings/${domain}?api-version=2023-01-01`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties: { siteName: AZURE_APP } }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as {
    Message?: string;
    error?: { message?: string };
  };
  if (res.ok) return { ok: true, detail: `Hostname bound (${res.status})` };
  return {
    ok: false,
    detail: data.Message ?? data.error?.message ?? `HTTP ${res.status}`,
  };
}

export async function azureCreateCert(
  token: string,
  domain: string,
): Promise<{ ok: boolean; thumbprint?: string; detail: string }> {
  if (!AZURE_PLAN) return { ok: false, detail: "AZURE_APP_PLAN is not set" };
  const res = await fetch(
    `https://management.azure.com/subscriptions/${AZURE_SUB}/resourceGroups/${AZURE_RG}/providers/Microsoft.Web/certificates/${domain}?api-version=2023-01-01`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location: AZURE_LOCATION,
        properties: {
          canonicalName: domain,
          serverFarmId: `/subscriptions/${AZURE_SUB}/resourceGroups/${AZURE_RG}/providers/Microsoft.Web/serverfarms/${AZURE_PLAN}`,
        },
      }),
    },
  );

  if (res.status === 202) {
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      const check = await fetch(
        `https://management.azure.com/subscriptions/${AZURE_SUB}/resourceGroups/${AZURE_RG}/providers/Microsoft.Web/certificates/${domain}?api-version=2023-01-01`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (check.ok) {
        const cert = (await check.json()) as {
          properties?: { thumbprint?: string };
        };
        const tp = cert.properties?.thumbprint;
        if (tp) return { ok: true, thumbprint: tp, detail: `Cert issued: ${tp}` };
      }
    }
    return {
      ok: false,
      detail:
        "Cert provisioning timed out after 2 minutes. It may still complete — check Azure portal.",
    };
  }

  if (res.status === 409) {
    const get = await fetch(
      `https://management.azure.com/subscriptions/${AZURE_SUB}/resourceGroups/${AZURE_RG}/providers/Microsoft.Web/certificates/${domain}?api-version=2023-01-01`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (get.ok) {
      const cert = (await get.json()) as {
        properties?: { thumbprint?: string };
      };
      return {
        ok: true,
        thumbprint: cert.properties?.thumbprint,
        detail: "Cert already exists",
      };
    }
  }

  const data = (await res.json().catch(() => ({}))) as { Message?: string };
  return { ok: false, detail: data.Message ?? `HTTP ${res.status}` };
}

export async function azureBindSsl(
  token: string,
  domain: string,
  thumbprint: string,
): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(
    `https://management.azure.com/subscriptions/${AZURE_SUB}/resourceGroups/${AZURE_RG}/providers/Microsoft.Web/sites/${AZURE_APP}?api-version=2023-01-01`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          hostNameSslStates: [
            {
              name: domain,
              sslState: "SniEnabled",
              thumbprint,
              toUpdate: true,
            },
          ],
        },
      }),
    },
  );
  if (res.ok) return { ok: true, detail: "SSL binding created" };
  const data = (await res.json().catch(() => ({}))) as { Message?: string };
  return { ok: false, detail: data.Message ?? `HTTP ${res.status}` };
}
