import { aiAuthoringEnabled } from "@/lib/ai/authoring/limits";
import { getAiSettings } from "@/lib/db/ai-settings";

// The two rules AI marking of written answers is built to: the starting
// answers to open questions 3 and 4 on card f84f7899
// (docs/plans/2026-10-29-ai-authoring.md). A different answer to either
// changes this file.

// Q3: an AI mark is provisional until an instructor confirms or overrides it.
// Until then the automatically marked questions alone decide pass or fail; the
// attempt may still show a provisional score that includes the AI's marks.
export const AI_MARKS_DECIDE_PASS = false;

export function markDecidesPass(source: "ai" | "instructor"): boolean {
  return source === "instructor" || AI_MARKS_DECIDE_PASS;
}

// Q4: a learner's written answer goes to the model provider only where the
// platform switch (AI_AUTHORING_TENANTS, lib/ai/authoring/limits.ts) is on for
// the tenant AND the tenant's admin turned AI marking on (lms.TenantAiSetting,
// off by default). With either off, a written answer waits for an instructor.
// The platform switch is read first, so with it off the setting isn't read.
export async function aiMarkingEnabled(
  tenantId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (!(await aiAuthoringEnabled(tenantId, env))) return false;
  return (await getAiSettings(tenantId)).gradeWrittenAnswers;
}
