import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTimeZone, localDate, DEFAULT_TIME_ZONE } from "./local-date";

test("resolveTimeZone keeps a valid IANA zone", () => {
  assert.equal(resolveTimeZone("Asia/Tokyo"), "Asia/Tokyo");
});

test("resolveTimeZone falls back on garbage, empty and null", () => {
  assert.equal(resolveTimeZone("Not/AZone"), DEFAULT_TIME_ZONE);
  assert.equal(resolveTimeZone(""), DEFAULT_TIME_ZONE);
  assert.equal(resolveTimeZone(null), DEFAULT_TIME_ZONE);
  assert.equal(DEFAULT_TIME_ZONE, "America/Vancouver");
});

test("localDate is the learner's calendar date, not UTC", () => {
  const now = new Date("2026-09-02T06:30:00Z");
  assert.equal(localDate(now, "America/Vancouver"), "2026-09-01");
  assert.equal(localDate(now, "Asia/Tokyo"), "2026-09-02");
  assert.equal(localDate(now, "UTC"), "2026-09-02");
});
