import { createMailClient, sendFormToSupport, type FormToSupportInput, type MailClient } from "@/lib/vendor/mail";
import { recordError } from "@/lib/logging";
import { queryOne } from "@/lib/db";
import { getTenantProfile } from "@/lib/db/tenants";
import { tenantOrigin } from "@/lib/email-optout";
import { fetchSummaryMailToken } from "@/lib/summary-email";
import { getThemeForSlug } from "@/lib/tenant";

// every-form-every-email, rule 1: every learner form opens a ticket at the
// tenant's own support desk (lms.TenantBranding.SupportEmail), from the
// tenant's own sender, with the learner as Reply-To.

export type LearnerFeedback =
  | { kind: "course"; courseId: string; rating: number; comment: string | null }
  | { kind: "slide"; courseId: string; blockId: string; comment: string };

export interface FeedbackContext {
  courseTitle: string;
  courseSlug: string;
  lessonTitle?: string;
}

export interface FeedbackDesk {
  supportAddress: string;
  from: string;
  fromName?: string;
  origin: string;
}

export function feedbackForm(
  feedback: LearnerFeedback,
  context: FeedbackContext,
  desk: FeedbackDesk,
  person: { email: string; name?: string },
): FormToSupportInput {
  const course = { label: "Course", value: context.courseTitle };
  const learner = { label: "Learner", value: person.name && person.name !== person.email ? `${person.name} <${person.email}>` : person.email };
  const review = { label: "Review it at", value: `${desk.origin}/admin/courses/${encodeURIComponent(context.courseSlug)}` };
  const fields = feedback.kind === "course"
    ? [course, learner, { label: "Rating", value: `${feedback.rating} of 5` }, { label: "Comment", value: feedback.comment ?? "(none)" }, review]
    : [course, { label: "Lesson", value: context.lessonTitle ?? "(unknown lesson)" }, learner, { label: "Comment", value: feedback.comment }, review];
  return {
    from: desk.from,
    ...(desk.fromName ? { fromName: desk.fromName } : {}),
    supportAddress: desk.supportAddress,
    person: { email: person.email, ...(person.name ? { name: person.name } : {}) },
    subject: feedback.kind === "course"
      ? `Course feedback: ${context.courseTitle} (${feedback.rating} of 5)`
      : `Slide feedback: ${context.courseTitle}${context.lessonTitle ? ` / ${context.lessonTitle}` : ""}`,
    fields,
  };
}

async function feedbackDesk(tenantId: string): Promise<FeedbackDesk> {
  const profile = await getTenantProfile(tenantId);
  if (!profile) throw new Error("tenant not found or inactive");
  if (!profile.SupportEmail) throw new Error(`tenant ${profile.Slug} has no SupportEmail`);
  const sender = (await getThemeForSlug(profile.Slug))?.email_sender;
  const from = sender?.address ?? process.env.LMS_DIGEST_FROM;
  if (!from) throw new Error(`tenant ${profile.Slug} has no sender mailbox`);
  return {
    supportAddress: profile.SupportEmail,
    from,
    ...(sender?.display_name ? { fromName: sender.display_name } : {}),
    origin: tenantOrigin({ slug: profile.Slug, customHostname: profile.CustomHostname }),
  };
}

async function feedbackContext(feedback: LearnerFeedback): Promise<FeedbackContext> {
  if (feedback.kind === "course") {
    const row = await queryOne<{ Title: string; Slug: string }>(
      `SELECT Title, Slug FROM lms.Course WHERE CourseId = @courseId`, { courseId: feedback.courseId });
    if (!row) throw new Error(`course ${feedback.courseId} not found`);
    return { courseTitle: row.Title, courseSlug: row.Slug };
  }
  const row = await queryOne<{ Title: string; Slug: string; LessonTitle: string }>(
    `SELECT c.Title, c.Slug, l.Title AS LessonTitle
       FROM lms.Block b
       JOIN lms.Lesson l ON l.LessonId = b.LessonId
       JOIN lms.Course c ON c.CourseId = l.CourseId
      WHERE b.BlockId = @blockId AND c.CourseId = @courseId`,
    { blockId: feedback.blockId, courseId: feedback.courseId });
  if (!row) throw new Error(`block ${feedback.blockId} not found in course ${feedback.courseId}`);
  return { courseTitle: row.Title, courseSlug: row.Slug, lessonTitle: row.LessonTitle };
}

let client: MailClient | null = null;

/**
 * The feedback row is already saved when this runs, so it never throws: a
 * ticket that could not be opened is logged, and the learner's submission
 * still succeeds.
 */
export async function sendFeedbackToSupport(
  tenantId: string,
  person: { email: string; name?: string },
  feedback: LearnerFeedback,
): Promise<boolean> {
  try {
    const desk = await feedbackDesk(tenantId);
    const context = await feedbackContext(feedback);
    client ??= createMailClient(fetchSummaryMailToken);
    const result = await sendFormToSupport(client, feedbackForm(feedback, context, desk, person));
    if (!result.ok) throw new Error(result.error ? `${result.error.kind}: ${result.error.message}` : "send failed");
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await recordError("lms-feedback-intake", `${feedback.kind} feedback from tenant ${tenantId} opened no ticket: ${reason}`, "ERROR")
      .catch(() => undefined);
    return false;
  }
}
