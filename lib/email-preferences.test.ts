import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emailPreferencesReducer,
  initialEmailPreferences,
  toggleEmailPreference,
  type EmailPreferencesAction,
  type EmailPreferencesState,
} from "./email-preferences";

const categories = [
  { key: "summary", label: "Daily summary", on: true },
  { key: "reminders", label: "Reminders", on: false },
];

function harness() {
  let state: EmailPreferencesState = initialEmailPreferences(categories);
  const dispatch = (action: EmailPreferencesAction) => {
    state = emailPreferencesReducer(state, action);
  };
  return { dispatch, get state() { return state; }, inFlight: new Set<string>() };
}

test("a saved press keeps the new value", async () => {
  const h = harness();
  assert.equal(await toggleEmailPreference("reminders", true, async () => {}, h.dispatch, h.inFlight), "saved");
  assert.deepEqual(h.state, { on: { summary: true, reminders: true }, pending: [], error: null });
});

test("a failed or throwing save flips back and flags that row", async () => {
  const h = harness();
  assert.equal(await toggleEmailPreference("summary", false, async () => { throw new Error("no"); }, h.dispatch, h.inFlight), "failed");
  assert.deepEqual(h.state, { on: { summary: true, reminders: false }, pending: [], error: "summary" });
  await toggleEmailPreference("summary", false, async () => {}, h.dispatch, h.inFlight);
  assert.equal(h.state.error, null);
});

test("a second press while saving is ignored, and a server sync keeps the switch mid-save", async () => {
  const h = harness();
  let release!: () => void;
  const first = toggleEmailPreference("reminders", true, () => new Promise<void>((r) => (release = r)), h.dispatch, h.inFlight);
  assert.equal(await toggleEmailPreference("reminders", false, async () => {}, h.dispatch, h.inFlight), "busy");
  h.dispatch({ type: "sync", categories: [{ ...categories[0]!, on: false }, categories[1]!] });
  assert.deepEqual(h.state.on, { summary: false, reminders: true });
  release();
  assert.equal(await first, "saved");
  assert.deepEqual(h.state.pending, []);
});

test("a sync with nothing new returns the same state object", () => {
  const state = initialEmailPreferences(categories);
  assert.equal(emailPreferencesReducer(state, { type: "sync", categories }), state);
});
