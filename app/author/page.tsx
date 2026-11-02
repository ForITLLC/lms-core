import type { FC, ReactNode } from "react";
import ShellRaw from "@/components/Shell";
import Button from "@/components/Button";
import AuthorCourseList from "@/components/author/AuthorCourseList";
import NewCourseForm from "@/components/author/NewCourseForm";
import NoTenantNotice from "@/components/author/NoTenantNotice";
import { requireAuthorPage } from "@/lib/auth/author-page";
import { aiAuthoringEnabled } from "@/lib/ai/authoring/limits";
import { listAuthorCourses } from "@/lib/db/course-drafts";
import { countAnswersAwaitingInstructor } from "@/lib/db/answer-grades";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

export default async function AuthorPage() {
  const access = await requireAuthorPage("/author");
  if (!access.ok) {
    return (
      <Shell title="Author tools">
        <NoTenantNotice />
      </Shell>
    );
  }

  const [courses, aiEnabled, waiting] = await Promise.all([
    listAuthorCourses(access.tenantId),
    aiAuthoringEnabled(access.tenantId),
    countAnswersAwaitingInstructor(access.tenantId),
  ]);

  return (
    <Shell title="Author tools">
      <div className="space-y-6">
        <p className="max-w-prose text-gray-700">
          Build and edit your courses. Changes stay in a draft until you publish, and learners already enrolled keep the
          version they started.
        </p>
        <NewCourseForm />
        {aiEnabled ? (
          <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:flex-row sm:items-center">
            <Button href="/author/ingestions/new" prefetch={false}>
              Create with AI
            </Button>
            <p className="text-sm text-gray-600">
              Draft a course from a YouTube video, a web page or your own text, then review it here before you publish.
            </p>
          </div>
        ) : null}
        <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:flex-row sm:items-center">
          <Button href="/author/grading" variant="outline" prefetch={false}>
            {waiting > 0 ? `Marking (${waiting})` : "Marking"}
          </Button>
          <p className="text-sm text-gray-600">
            {waiting === 0
              ? "No written answers are waiting for an instructor."
              : `${waiting} written ${waiting === 1 ? "answer is" : "answers are"} waiting for an instructor.`}
          </p>
        </div>
        <AuthorCourseList courses={courses} />
      </div>
    </Shell>
  );
}
