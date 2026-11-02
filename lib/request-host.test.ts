import { test } from "node:test";
import assert from "node:assert/strict";
import { requestHost } from "./request-host";
import { authConfig } from "./auth-config";
import { GET as manifest } from "../app/api/mcp-manifest.json/route";

const h = (init: Record<string, string>) => new Headers(init);
const SPOOF = { host: "charter.learn.forit.io", "x-forwarded-host": "evil.example.com" };

test("the request host is Host; a client-sent forwarded host is ignored", () => {
  assert.equal(requestHost(h(SPOOF), {}), "charter.learn.forit.io");
  assert.equal(requestHost(h({ host: "charter.learn.forit.io", "x-original-host": "evil.example.com" }), {}), "charter.learn.forit.io");
  assert.equal(requestHost(h(SPOOF), { LMS_TRUST_FORWARDED_HOST: "1" }), "charter.learn.forit.io");
  assert.equal(requestHost(h({}), {}), null);
});

test("LMS_TRUST_FORWARDED_HOST=true takes the first forwarded host, falling back to Host", () => {
  const trust = { LMS_TRUST_FORWARDED_HOST: "true" };
  assert.equal(requestHost(h({ host: "lms:3000", "x-forwarded-host": "learn.example.org, lms:3000" }), trust), "learn.example.org");
  assert.equal(requestHost(h({ host: "lms:3000", "x-forwarded-host": " " }), trust), "lms:3000");
  assert.equal(requestHost(h({ host: "lms:3000" }), trust), "lms:3000");
});

test("sign-in redirects and the MCP manifest stay on the host the request was sent to", async () => {
  const before = process.env.LMS_TRUST_FORWARDED_HOST;
  delete process.env.LMS_TRUST_FORWARDED_HOST;
  try {
    const req = { headers: h(SPOOF), url: "http://0.0.0.0:8080/api/auth/login" };
    const fn = (v: unknown) => v as (r: unknown) => string;
    assert.equal(fn(authConfig.redirectUri)(req), "https://charter.learn.forit.io/api/auth/callback");
    assert.equal(fn(authConfig.baseUrl)(req), "https://charter.learn.forit.io");
    const body = await manifest(new Request("http://0.0.0.0:8080/api/mcp-manifest.json", { headers: h(SPOOF) }) as never).json();
    assert.equal(body.baseUrl, "https://charter.learn.forit.io/api/v1");
    assert.equal(body.specUrl, "https://charter.learn.forit.io/api/openapi.json");
  } finally {
    if (before === undefined) delete process.env.LMS_TRUST_FORWARDED_HOST;
    else process.env.LMS_TRUST_FORWARDED_HOST = before;
  }
});
