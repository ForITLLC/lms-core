import { test } from "node:test";
import assert from "node:assert/strict";
import { isWorkday, missedWorkdaysBetween, advanceStreak, type StreakStats } from "./streak";

const base = (over: Partial<StreakStats> = {}): StreakStats => ({
  currentStreak: 3,
  longestStreak: 5,
  lastCompletedLocalDate: "2026-08-31", // Monday
  freezesAvailable: 1,
  ...over,
});

test("isWorkday is Monday to Friday", () => {
  assert.equal(isWorkday("2026-08-31"), true); // Mon
  assert.equal(isWorkday("2026-09-04"), true); // Fri
  assert.equal(isWorkday("2026-09-05"), false); // Sat
  assert.equal(isWorkday("2026-09-06"), false); // Sun
});

test("missedWorkdaysBetween ignores weekends", () => {
  assert.equal(missedWorkdaysBetween("2026-09-04", "2026-09-07"), 0); // Fri -> Mon
  assert.equal(missedWorkdaysBetween("2026-08-31", "2026-09-01"), 0); // Mon -> Tue
  assert.equal(missedWorkdaysBetween("2026-08-31", "2026-09-02"), 1); // Mon -> Wed
  assert.equal(missedWorkdaysBetween("2026-08-31", "2026-09-03"), 2); // Mon -> Thu
  assert.equal(missedWorkdaysBetween("2026-09-03", "2026-09-08"), 2); // Thu -> next Tue (skips Fri, Mon)
  assert.equal(missedWorkdaysBetween(null, "2026-09-08"), 0);
});

test("same day completion is idempotent", () => {
  const r = advanceStreak(base(), "2026-08-31");
  assert.deepEqual(r, { ...base(), freezesConsumed: 0, changed: false });
});

test("next workday extends the streak", () => {
  const r = advanceStreak(base(), "2026-09-01");
  assert.equal(r.currentStreak, 4);
  assert.equal(r.freezesAvailable, 1);
  assert.equal(r.freezesConsumed, 0);
  assert.equal(r.lastCompletedLocalDate, "2026-09-01");
  assert.equal(r.changed, true);
});

test("Friday to Monday continues without touching freezes", () => {
  const r = advanceStreak(base({ lastCompletedLocalDate: "2026-09-04" }), "2026-09-07");
  assert.equal(r.currentStreak, 4);
  assert.equal(r.freezesAvailable, 1);
});

test("one missed workday consumes a freeze and keeps the streak", () => {
  const r = advanceStreak(base(), "2026-09-02");
  assert.equal(r.currentStreak, 4);
  assert.equal(r.freezesAvailable, 0);
  assert.equal(r.freezesConsumed, 1);
});

test("more missed workdays than freezes resets to 1", () => {
  const r = advanceStreak(base(), "2026-09-03");
  assert.equal(r.currentStreak, 1);
  assert.equal(r.freezesAvailable, 1); // untouched: a reset does not burn the freeze
  assert.equal(r.freezesConsumed, 0);
});

test("a weekend completion counts as a day and does not break anything", () => {
  const r = advanceStreak(base({ lastCompletedLocalDate: "2026-09-04" }), "2026-09-05");
  assert.equal(r.currentStreak, 4);
  const r2 = advanceStreak({ ...r, freezesConsumed: undefined, changed: undefined } as StreakStats, "2026-09-07");
  assert.equal(r2.currentStreak, 5);
});

test("every seventh day earns a freeze, capped at two", () => {
  const r = advanceStreak(base({ currentStreak: 6, freezesAvailable: 1 }), "2026-09-01");
  assert.equal(r.currentStreak, 7);
  assert.equal(r.freezesAvailable, 2);
  const r2 = advanceStreak(base({ currentStreak: 13, freezesAvailable: 2 }), "2026-09-01");
  assert.equal(r2.freezesAvailable, 2);
});

test("longest streak tracks the max", () => {
  const r = advanceStreak(base({ currentStreak: 5, longestStreak: 5 }), "2026-09-01");
  assert.equal(r.longestStreak, 6);
  const r2 = advanceStreak(base({ currentStreak: 1, longestStreak: 9 }), "2026-09-01");
  assert.equal(r2.longestStreak, 9);
});

test("first ever completion starts at 1", () => {
  const r = advanceStreak(
    { currentStreak: 0, longestStreak: 0, lastCompletedLocalDate: null, freezesAvailable: 1 },
    "2026-09-01",
  );
  assert.equal(r.currentStreak, 1);
  assert.equal(r.longestStreak, 1);
});
