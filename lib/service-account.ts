// Shared service-account heuristic used by the Graph roster filter and the
// daily-digest pre-flight. Matches shared mailboxes (alerts@, calendar@),
// Power Automate principals (planner-sync-svc@, SVC-FLOW-PROD@), legacy
// GA_*/test.* accounts, and svc-prefixed mailboxes. The cost of a false
// positive is one missed daily digest; the cost of a false negative is a
// noise complaint from whichever team owns the shared inbox.

// Prefix list. "test" (without trailing dot) catches both "test.admin" and
// "testautomation" / "testplanneruser" — no real ForIT human has a username
// starting with "test", so broadening is safe.
const SERVICE_PREFIXES = ["svc-", "ga_", "test"];
const SERVICE_LOCAL_PARTS = new Set([
  "alerts",
  "calendar",
  "issuelog",
  "notes",
  "tasks",
  "support",
  "planner-sync-svc",
  "learning",
]);

export function isServiceAccount(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (!local) return true;
  if (SERVICE_LOCAL_PARTS.has(local)) return true;
  return SERVICE_PREFIXES.some((p) => local.startsWith(p));
}
