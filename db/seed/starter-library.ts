import type { CourseSeed } from "@/db/seed/course-seed";
import phishing from "@/db/seed/courses/phishing-security-awareness.course";
import accountSecurity from "@/db/seed/courses/account-security-fundamentals.course";
import handlingClientData from "@/db/seed/courses/handling-client-data.course";
import incidentResponse from "@/db/seed/courses/incident-response.course";
import aiAtWork from "@/db/seed/courses/ai-at-work.course";
import historyOfCloud from "@/db/seed/courses/history-of-cloud-computing.course";
import historyOfAi from "@/db/seed/courses/history-of-ai.course";
import lmsAuthoring from "@/db/seed/courses/authoring-in-the-forit-lms.course";

// The starter library a self-hosted install seeds: the courses the readiness
// audit cleared to ship, in the hosted library's order.
export const STARTER_COURSES: CourseSeed[] = [
  phishing,
  accountSecurity,
  handlingClientData,
  incidentResponse,
  aiAtWork,
  historyOfCloud,
  historyOfAi,
  lmsAuthoring,
];
