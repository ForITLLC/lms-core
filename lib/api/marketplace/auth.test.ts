import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  FORIT_ENTRA_TENANT_ID,
  requireMarketplaceCaller,
  type JwksFetcher,
  type MarketplaceAuthDeps,
  type MarketplaceCallerGate,
  type MarketplaceRole,
} from "./auth";

const CLIENT = "11111111-1111-1111-1111-111111111111";
const CALLER = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";
const ENV = { AZURE_AD_CLIENT_ID: CLIENT, MARKETPLACE_CALLER_APP_ID: CALLER };
const WRITE: MarketplaceRole = "Marketplace.Entitlements.Write";
const NOW = new Date("2026-10-28T12:00:00Z");
const NOW_S = NOW.getTime() / 1000;

const signer = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwk(key: KeyObject, kid: string) {
  return { ...key.export({ format: "jwk" }), kid, use: "sig" };
}

function jwks(...keys: ReturnType<typeof jwk>[]) {
  const counter = { calls: 0 };
  const fetchJwks: JwksFetcher = async () => {
    counter.calls += 1;
    return { keys };
  };
  return { fetchJwks, counter };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function token(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
  key: KeyObject = signer.privateKey,
): string {
  const signingInput = `${b64({ alg: "RS256", typ: "JWT", kid: "k1", ...header })}.${b64(claims)}`;
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), key).toString("base64url")}`;
}

const v1 = {
  aud: `api://${CLIENT}`,
  iss: `https://sts.windows.net/${FORIT_ENTRA_TENANT_ID}/`,
  iat: NOW_S - 60,
  nbf: NOW_S - 60,
  exp: NOW_S + 3600,
  tid: FORIT_ENTRA_TENANT_ID,
  appid: CALLER,
  idtyp: "app",
  roles: [WRITE],
  ver: "1.0",
};

const v2 = {
  aud: CLIENT,
  iss: `https://login.microsoftonline.com/${FORIT_ENTRA_TENANT_ID}/v2.0`,
  iat: NOW_S - 60,
  nbf: NOW_S - 60,
  exp: NOW_S + 3600,
  tid: FORIT_ENTRA_TENANT_ID,
  azp: CALLER,
  roles: [WRITE, "Marketplace.Catalogue.Read"],
  ver: "2.0",
};

function call(
  authorization: string | null,
  deps: MarketplaceAuthDeps = {},
  role: MarketplaceRole = WRITE,
): Promise<MarketplaceCallerGate> {
  const headers: Record<string, string> = authorization === null ? {} : { authorization };
  return requireMarketplaceCaller(new Request("https://lms.test/api/marketplace/entitlements", { headers }), role, {
    env: ENV,
    fetchJwks: jwks(jwk(signer.publicKey, "k1")).fetchJwks,
    now: () => NOW,
    ...deps,
  });
}

async function assertRefused(gate: MarketplaceCallerGate, status: 401 | 403, label: string) {
  assert.equal(gate.ok, false, label);
  if (gate.ok) throw new Error(label);
  const code = status === 401 ? "invalid_token" : "insufficient_scope";
  assert.equal(gate.response.status, status, label);
  assert.equal(gate.response.headers.get("www-authenticate"), `Bearer realm="lms", error="${code}"`, label);
  const body = await gate.response.json();
  assert.equal(body.error, code, label);
  assert.equal(body.status, status, label);
  assert.equal(typeof body.error_description, "string", label);
  return body as { error: string; status: number; error_description: string };
}

test("a v1 marketplace token (sts issuer, appid, api:// audience) passes", async () => {
  const gate = await call(`Bearer ${token(v1)}`);
  assert.ok(gate.ok);
  assert.deepEqual(gate.caller, { appId: CALLER, roles: [WRITE] });
});

test("a v2 marketplace token (login issuer, azp, bare client audience) passes", async () => {
  const gate = await call(`Bearer ${token(v2)}`, {}, "Marketplace.Catalogue.Read");
  assert.ok(gate.ok);
  assert.equal(gate.caller.appId, CALLER);
});

test("a token without the route's app role is 403 insufficient_scope", async () => {
  await assertRefused(await call(`Bearer ${token(v1)}`, {}, "Marketplace.Usage.Read"), 403, "missing role");
  await assertRefused(await call(`Bearer ${token({ ...v1, roles: undefined })}`), 403, "no roles claim");
});

test("only RS256 is accepted: alg none, HS256 keyed with the public key, ES256 and RS384 are refused", async () => {
  const real = token(v1).split(".");
  const none = `${b64({ alg: "none", typ: "JWT", kid: "k1" })}.${real[1]}`;
  await assertRefused(await call(`Bearer ${none}.`), 401, "alg none, empty signature");
  await assertRefused(await call(`Bearer ${none}.${real[2]}`), 401, "alg none, RS256 signature attached");

  const hsInput = `${b64({ alg: "HS256", typ: "JWT", kid: "k1" })}.${real[1]}`;
  const secret = signer.publicKey.export({ type: "spki", format: "pem" });
  const hs = `${hsInput}.${createHmac("sha256", secret).update(hsInput).digest("base64url")}`;
  await assertRefused(await call(`Bearer ${hs}`), 401, "HS256 with the public key as secret");

  for (const alg of ["ES256", "RS384", "PS256"]) {
    await assertRefused(await call(`Bearer ${token(v1, { alg })}`), 401, alg);
  }
  await assertRefused(await call(`Bearer ${token(v1, { kid: undefined })}`), 401, "no kid");
});

test("a header that names or embeds its own key is refused, even when the signature is good", async () => {
  for (const header of [{ jku: "https://evil.test/keys" }, { x5u: "https://evil.test/cert" }, { jwk: jwk(signer.publicKey, "k1") }]) {
    await assertRefused(await call(`Bearer ${token(v1, header)}`), 401, Object.keys(header)[0] ?? "");
  }
});

test("a payload changed after signing is refused", async () => {
  const [header, , signature] = token(v1).split(".");
  const tampered = `${header}.${b64({ ...v1, roles: [WRITE, "Marketplace.Usage.Read"] })}.${signature}`;
  await assertRefused(await call(`Bearer ${tampered}`), 401, "tampered payload");
});

test("a token signed by a key outside the ForIT JWKS is refused", async () => {
  await assertRefused(await call(`Bearer ${token(v1, { kid: "k2" }, rotated.privateKey)}`), 401, "unknown kid");
  await assertRefused(await call(`Bearer ${token(v1, {}, rotated.privateKey)}`), 401, "known kid, wrong key");
});

test("keys cache for an hour; an unknown kid refetches at most once per 5 minutes", async () => {
  let published = [jwk(signer.publicKey, "k1")];
  let calls = 0;
  const fetchJwks: JwksFetcher = async () => {
    calls += 1;
    return { keys: published };
  };
  let clock = NOW.getTime();
  const deps = { fetchJwks, now: () => new Date(clock) };
  const minutes = (n: number) => n * 60_000;
  const rotatedToken = (at: number) =>
    token({ ...v1, exp: at / 1000 + 3600 }, { kid: "k2" }, rotated.privateKey);

  assert.ok((await call(`Bearer ${token(v1)}`, deps)).ok);
  assert.equal(calls, 1);
  published = [jwk(signer.publicKey, "k1"), jwk(rotated.publicKey, "k2")];
  await assertRefused(await call(`Bearer ${rotatedToken(clock)}`, deps), 401, "within 5 min of the last fetch");
  assert.equal(calls, 1);

  clock += minutes(6);
  assert.ok((await call(`Bearer ${rotatedToken(clock)}`, deps)).ok, "a key Entra rotated in is picked up");
  assert.equal(calls, 2);

  await assertRefused(await call(`Bearer ${token(v1, { kid: "k9" })}`, deps), 401, "random kid");
  clock += minutes(4);
  await assertRefused(await call(`Bearer ${token({ ...v1, exp: clock / 1000 + 3600 }, { kid: "k9" })}`, deps), 401, "random kid");
  assert.equal(calls, 2);

  clock += minutes(61);
  assert.ok((await call(`Bearer ${token({ ...v1, exp: clock / 1000 + 3600 })}`, deps)).ok);
  assert.equal(calls, 3, "the key set expires after an hour");
});

test("a JWKS fetch failure is a 401, not a thrown error", async () => {
  const fetchJwks: JwksFetcher = async () => {
    throw new Error("network down");
  };
  await assertRefused(await call(`Bearer ${token(v1)}`, { fetchJwks }), 401, "fetch failure");
  await assertRefused(await call(`Bearer ${token(v1)}`, { fetchJwks: async () => ({ nope: 1 }) }), 401, "no keys array");
});

test("a JWKS fetch failure is recorded, and a failing recorder still leaves a 401", async () => {
  const fetchJwks: JwksFetcher = async () => {
    throw new Error("JWKS fetch returned 503");
  };
  const recorded: string[] = [];
  await assertRefused(
    await call(`Bearer ${token(v1)}`, { fetchJwks, recordError: async (message) => recorded.push(message) }),
    401,
    "recorded",
  );
  assert.deepEqual(recorded, ["marketplace.jwks: JWKS fetch returned 503"]);

  const throws = () => {
    throw new Error("logging down");
  };
  await assertRefused(await call(`Bearer ${token(v1)}`, { fetchJwks, recordError: throws }), 401, "recorder throws");
  await assertRefused(
    await call(`Bearer ${token(v1)}`, { fetchJwks, recordError: async () => Promise.reject(new Error("logging down")) }),
    401,
    "recorder rejects",
  );
});

test("a bad signature or an unknown kid is not logged as a JWKS failure", async () => {
  const recorded: string[] = [];
  const recordError = async (message: string) => recorded.push(message);
  await assertRefused(await call(`Bearer ${token(v1, {}, rotated.privateKey)}`, { recordError }), 401, "wrong key");
  await assertRefused(await call(`Bearer ${token(v1, { kid: "k2" })}`, { recordError }), 401, "unknown kid");
  assert.deepEqual(recorded, []);
});

test("exp and nbf hold to 60 seconds of clock skew", async () => {
  assert.ok((await call(`Bearer ${token({ ...v1, exp: NOW_S - 30 })}`)).ok, "expired 30s ago, inside skew");
  await assertRefused(await call(`Bearer ${token({ ...v1, exp: NOW_S - 61 })}`), 401, "expired 61s ago");
  await assertRefused(await call(`Bearer ${token({ ...v1, exp: undefined })}`), 401, "no exp");
  assert.ok((await call(`Bearer ${token({ ...v1, nbf: NOW_S + 30 })}`)).ok, "nbf 30s ahead, inside skew");
  await assertRefused(await call(`Bearer ${token({ ...v1, nbf: NOW_S + 120 })}`), 401, "nbf 2 min ahead");
});

test("a token from another tenant is refused even with the ForIT issuer", async () => {
  await assertRefused(await call(`Bearer ${token({ ...v1, tid: OTHER })}`), 401, "wrong tid");
});

test("a token from another issuer is refused", async () => {
  for (const iss of [`https://sts.windows.net/${OTHER}/`, `https://login.microsoftonline.com/${OTHER}/v2.0`, "https://evil.test/"]) {
    await assertRefused(await call(`Bearer ${token({ ...v1, iss })}`), 401, iss);
  }
});

test("a token for another audience is refused", async () => {
  for (const aud of [OTHER, `api://${OTHER}`, "https://graph.microsoft.com"]) {
    await assertRefused(await call(`Bearer ${token({ ...v1, aud })}`), 401, aud);
  }
});

test("a token from another app, or a user token, is refused", async () => {
  await assertRefused(await call(`Bearer ${token({ ...v1, appid: OTHER })}`), 401, "wrong appid");
  await assertRefused(await call(`Bearer ${token({ ...v2, azp: OTHER })}`), 401, "wrong azp");
  await assertRefused(await call(`Bearer ${token({ ...v1, idtyp: "user" })}`), 401, "idtyp user");
  await assertRefused(await call(`Bearer ${token({ ...v2, scp: "user_impersonation" })}`), 401, "delegated scp");
});

test("an unconfigured LMS refuses every caller before reading the token", async () => {
  const counted = jwks(jwk(signer.publicKey, "k1"));
  for (const env of [{ AZURE_AD_CLIENT_ID: CLIENT }, { AZURE_AD_CLIENT_ID: CLIENT, MARKETPLACE_CALLER_APP_ID: "" }, { MARKETPLACE_CALLER_APP_ID: CALLER }]) {
    const body = await assertRefused(await call(`Bearer ${token(v1)}`, { env, fetchJwks: counted.fetchJwks }), 401, JSON.stringify(env));
    assert.equal(body.error_description, "marketplace caller not configured");
  }
  assert.equal(counted.counter.calls, 0);
});

test("a tenant lms_ API key is refused without touching the JWKS", async () => {
  const fetchJwks: JwksFetcher = async () => {
    throw new Error("the JWKS must not be fetched for an lms_ key");
  };
  const body = await assertRefused(await call("Bearer lms_abc", { fetchJwks }), 401, "lms_ key");
  assert.equal(body.error_description, "tenant API keys cannot call marketplace routes");
});

test("no bearer, or a token that is not a compact JWS, is refused", async () => {
  await assertRefused(await call(null), 401, "no header");
  await assertRefused(await call("Basic dXNlcjpwYXNz"), 401, "basic auth");
  const [h, p, s] = token(v1).split(".");
  for (const bad of ["abc", `${h}.${p}`, `${h}.${p}.${s}.${s}`, `${b64([1])}.${p}.${s}`, `bm90LWpzb24.${p}.${s}`, `${h}.${p}.${s}!`, `${h}.${p}.${"A".repeat(16_000)}`]) {
    await assertRefused(await call(`Bearer ${bad}`), 401, bad.slice(0, 40));
  }
});
