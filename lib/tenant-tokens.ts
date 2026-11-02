import type { CourseDetail, MaterializedBlock } from "@/lib/db/courses";
import type { QuizQuestion } from "@/lib/schema/quiz";

// Render-time white-label token resolution for course content. Course bodies
// are authored tenant-agnostically with {{company_name}} / {{support_email}} /
// {{work_email_domain}} tokens; we resolve them against the tenant's branding
// at render. The same course then serves every tenant, and a branding edit
// (e.g. a new sign-in domain) flows through without re-authoring.
//
// Unknown tokens are left untouched — never blank out something we can't
// resolve. Tolerant of surrounding whitespace: {{company_name}} == {{ company_name }}.

export interface TenantContentTokens {
  company_name?: string | null;
  support_email?: string | null;
  work_email_domain?: string | null;
}

const TOKEN_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

export function resolveContentTokens(
  text: string,
  tokens: TenantContentTokens,
): string {
  if (!text || text.indexOf("{{") === -1) return text;
  const map: Record<string, string | null | undefined> = {
    company_name: tokens.company_name,
    support_email: tokens.support_email,
    work_email_domain: tokens.work_email_domain,
  };
  return text.replace(TOKEN_RE, (full, key: string) => {
    const v = map[key];
    return typeof v === "string" && v.length > 0 ? v : full;
  });
}

function resolveQuestion(
  q: QuizQuestion,
  r: (s: string) => string,
): QuizQuestion {
  switch (q.kind) {
    case "mcq":
    case "confidence":
      return { ...q, promptMd: r(q.promptMd), choices: q.choices.map((c) => ({ ...c, label: r(c.label) })) };
    case "multi":
      return { ...q, promptMd: r(q.promptMd), choices: q.choices.map((c) => ({ ...c, label: r(c.label) })) };
    case "tf":
      return { ...q, promptMd: r(q.promptMd) };
    case "short":
      return { ...q, promptMd: r(q.promptMd), rubricMd: r(q.rubricMd) };
  }
}

function resolveBlock(b: MaterializedBlock, r: (s: string) => string): MaterializedBlock {
  switch (b.kind) {
    case "text":
      return { ...b, markdown: r(b.markdown) };
    case "callout":
      return { ...b, markdown: r(b.markdown) };
    case "image":
      return { ...b, alt: r(b.alt), caption: b.caption ? r(b.caption) : b.caption };
    case "quiz":
      return { ...b, questions: b.questions.map((q) => resolveQuestion(q, r)) };
    default:
      return b;
  }
}

// Resolves tokens across every text-bearing field of a course detail (block
// markdown, image alt/caption, quiz prompts + choice labels). Pure — returns a
// new detail, leaving the cached/DB value untouched. Answer keys are unchanged
// (correctness keys on choice id, not label), so grading is unaffected.
export function resolveCourseTokens(
  detail: CourseDetail,
  tokens: TenantContentTokens,
): CourseDetail {
  const r = (s: string) => resolveContentTokens(s, tokens);
  return {
    ...detail,
    lessons: detail.lessons.map((l) => ({
      ...l,
      blocks: l.blocks.map((b) => resolveBlock(b, r)),
    })),
  };
}
