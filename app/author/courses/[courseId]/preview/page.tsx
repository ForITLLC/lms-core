import type { FC, ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import ShellRaw from "@/components/Shell";
import NoTenantNotice from "@/components/author/NoTenantNotice";
import PreviewPlayer from "@/components/author/PreviewPlayer";
import { requireAuthorPage } from "@/lib/auth/author-page";
import { buildPreview } from "@/lib/builder/preview";
import { loadPreviewSource } from "@/lib/db/course-preview";
import { getTenantContentTokens } from "@/lib/db/tenants";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const COURSE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  params: Promise<{ courseId: string }>;
}

function Notice({ courseId, children }: { courseId: string; children: ReactNode }) {
  return (
    <Shell title="Course preview">
      <div className="space-y-4">
        <p className="text-gray-700">{children}</p>
        <Link
          href={`/author/courses/${courseId}`}
          prefetch={false}
          className="text-sm font-semibold hover:underline"
          style={{ color: "var(--brand-primary)" }}
        >
          ← Back to the editor
        </Link>
      </div>
    </Shell>
  );
}

// The course as a learner would play it: the draft when one is open, else the
// version learners see now. Answer keys are stripped before the props leave the
// server, and the player writes nothing (components/author/preview-effects.ts).
export default async function AuthorCoursePreviewPage({ params }: PageProps) {
  const { courseId } = await params;
  const access = await requireAuthorPage(`/author/courses/${courseId}/preview`);
  if (!access.ok) {
    return (
      <Shell title="Course preview">
        <NoTenantNotice />
      </Shell>
    );
  }
  if (!COURSE_ID.test(courseId)) notFound();
  const id = courseId.toLowerCase();

  const source = await loadPreviewSource(access.tenantId, id);
  if (!source) notFound();
  if (source.kind === "unreadable") return <Notice courseId={id}>{source.message}</Notice>;
  if (source.kind === "nothing") {
    return <Notice courseId={id}>This course has no draft and no published version yet, so there is nothing to preview.</Notice>;
  }

  const tokens = await getTenantContentTokens(access.tenantId);
  const preview = buildPreview({ courseId: id, slug: source.slug }, source.doc, tokens);
  const target =
    source.kind === "draft"
      ? { draftId: source.draftId, revision: source.revision }
      : { draftId: null, versionId: source.versionId };

  return (
    <Shell title={`Preview: ${preview.course.Title || "Untitled course"}`}>
      <PreviewPlayer courseId={id} target={target} preview={preview} />
    </Shell>
  );
}
