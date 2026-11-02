import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDueDay } from "./due-day";

test("formatDueDay shows the day an assignment was set for, west of UTC too", () => {
  const due = new Date("2026-10-20").toISOString();
  assert.equal(due, "2026-10-20T00:00:00.000Z");
  assert.equal(new Date(due).toLocaleDateString("en-US", { timeZone: "America/Vancouver" }), "10/19/2026");
  assert.equal(formatDueDay(due, "en-US"), "10/20/2026");
});

test("formatDueDay keeps a certificate expiry on its UTC date", () => {
  assert.equal(formatDueDay("2026-10-20T23:30:00.000Z", "en-US"), "10/20/2026");
});
