import type { FC, ReactNode } from "react";
import Link from "next/link";
import ShellRaw from "@/components/Shell";
import GradingQueue, { type QueueItem } from "@/components/author/GradingQueue";
import NoTenantNotice from "@/components/author/NoTenantNotice";
import { requireAuthorPage } from "@/lib/auth/author-page";
import { canMarkExams } from "@/lib/auth/records-permissions";
import { listAnswersAwaitingInstructor } from "@/lib/db/answer-grades";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

export default async function GradingPage() {
  const access = await requireAuthorPage("/author/grading", canMarkExams);
  if (!access.ok) {
    return (
      <Shell title="Marking">
        <NoTenantNotice />
      </Shell>
    );
  }

  const queue = await listAnswersAwaitingInstructor(access.tenantId);
  const items: QueueItem[] = queue.answers.map((a) => ({
    attemptId: a.attemptId,
    questionId: a.questionId,
    learnerName: a.learnerName,
    waitingSince: a.waitingSince ? a.waitingSince.toISOString() : null,
    courseTitle: a.courseTitle,
    lessonTitle: a.lessonTitle,
    questionNumber: a.questionNumber,
    promptMd: a.promptMd,
    rubricMd: a.rubricMd,
    maxScore: a.maxScore,
    answer: a.answer,
    aiGradeId: a.aiGradeId,
    aiScore: a.aiScore,
    aiMaxScore: a.aiMaxScore,
    aiFeedbackMd: a.aiFeedbackMd,
    instructorScore: a.instructorScore,
    review: a.review ? { note: a.review.note, requestedAt: a.review.requestedAt.toISOString() } : null,
  }));

  return (
    <Shell title="Marking">
      <div className="space-y-6">
        <Link href={access.staff ? "/author" : "/dashboard"} prefetch={false} className="text-sm font-semibold hover:underline" style={{ color: "var(--brand-primary)" }}>
          {access.staff ? "← Author tools" : "← Dashboard"}
        </Link>
        <p className="max-w-prose text-gray-700">
          Written answers waiting for an instructor, longest waiting first. An AI mark counts toward pass or fail only
          once you confirm it.
        </p>
        <GradingQueue items={items} total={queue.total} />
      </div>
    </Shell>
  );
}
