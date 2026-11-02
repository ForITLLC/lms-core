"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import CoursePlayer from "@/components/CoursePlayer";
import type { CoursePreview, PreviewTarget } from "@/lib/builder/preview";
import { Banner } from "./Banner";
import { previewEffects } from "./preview-effects";

// The learner player over a draft or the published version, with answer keys
// already stripped on the server (lib/builder/preview.ts) and every write
// swapped for the preview's own effects (./preview-effects.ts).
export default function PreviewPlayer({
  courseId,
  target,
  preview,
}: {
  courseId: string;
  target: PreviewTarget;
  preview: CoursePreview;
}) {
  const [stale, setStale] = useState<string | null>(null);
  const editorHref = `/author/courses/${encodeURIComponent(courseId)}`;
  const effects = useMemo(
    () =>
      previewEffects({
        courseId,
        target,
        quizKeys: preview.quizKeys,
        requiresQuizPass: preview.requiresQuizPass,
        packageBlocks: preview.packageBlocks,
        onStale: setStale,
      }),
    [courseId, target, preview.quizKeys, preview.requiresQuizPass, preview.packageBlocks],
  );

  return (
    <div className="space-y-4">
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      >
        <p>
          <span className="font-semibold">Preview — progress isn&rsquo;t saved.</span>{" "}
          {target.draftId === null
            ? "This is the published version; no draft is open."
            : `This is the draft at revision ${target.revision}.`}
        </p>
        <Link href={editorHref} prefetch={false} className="font-semibold hover:underline">
          Back to the editor
        </Link>
      </div>
      {stale ? <Banner tone="warning">{stale}</Banner> : null}
      <CoursePlayer
        course={preview.course}
        lessons={preview.lessons}
        effects={effects}
        exitLink={{ href: editorHref, label: "← Back to the editor" }}
      />
    </div>
  );
}
