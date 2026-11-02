"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DraftOp } from "@/lib/builder/draft-ops";
import Button from "@/components/Button";
import AddLessonForm from "./AddLessonForm";
import AiDraftBanner from "./AiDraftBanner";
import { hasUnsavedWork, isLayoutOp, lessonLimit, saveStatusLabel, toggledSet } from "./draft-helpers";
import LessonCard from "./LessonCard";
import MetaForm from "./MetaForm";
import ProblemList from "./ProblemList";
import PublishPanel from "./PublishPanel";
import SettingsPanel from "./SettingsPanel";
import VersionHistory from "./VersionHistory";
import { Banner } from "./Banner";
import type { AiOrigin } from "./ingestion-helpers";
import { useDraft, type DraftController, type LoadedDraft } from "./useDraft";

const BACK = (
  <Link href="/author" prefetch={false} className="text-sm font-semibold hover:underline" style={{ color: "var(--brand-primary)" }}>
    ← All courses
  </Link>
);

export default function CourseEditor({ courseId, aiOrigin = null }: { courseId: string; aiOrigin?: AiOrigin | null }) {
  const controller = useDraft(courseId);
  const { phase, draft } = controller;

  if (phase.kind === "loading") return <p className="text-gray-600">Opening the draft…</p>;

  if (phase.kind === "failed") {
    return (
      <div className="space-y-4">
        <Banner tone="error">{phase.message}</Banner>
        <div className="flex items-center gap-4">
          <Button size="sm" onClick={() => void controller.open()}>
            Open the course again
          </Button>
          {BACK}
        </div>
      </div>
    );
  }

  if (phase.kind === "published") {
    return (
      <div className="space-y-4">
        <Banner tone="success">
          Published version {phase.versionNumber}. Learners who start the course from now on get it; anyone already enrolled stays on
          their version.
        </Banner>
        <div className="flex items-center gap-4">
          <Button size="sm" onClick={() => void controller.open()}>
            Keep editing
          </Button>
          {BACK}
        </div>
      </div>
    );
  }

  if (!draft) return null;
  return <DraftEditor courseId={courseId} controller={controller} draft={draft} aiOrigin={aiOrigin} />;
}

// Block editors and the course forms report unsaved edits here under these
// keys; "#" can't appear in a block key, so the form keys never collide.
const DETAILS_KEY = "#details";
const SETTINGS_KEY = "#settings";

function DraftEditor({
  courseId,
  controller,
  draft,
  aiOrigin,
}: {
  courseId: string;
  controller: DraftController;
  draft: LoadedDraft;
  aiOrigin: AiOrigin | null;
}) {
  const router = useRouter();
  const { conflict, error, saving, saveFailed } = controller;
  const [openBlocks, setOpenBlocks] = useState<ReadonlySet<string>>(() => new Set());
  const isOpen = useCallback((key: string) => openBlocks.has(key), [openBlocks]);
  const setOpen = useCallback((key: string, open: boolean) => setOpenBlocks((current) => toggledSet(current, key, open)), []);
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const setDirty = useCallback((key: string, dirty: boolean) => setDirtyKeys((current) => toggledSet(current, key, dirty)), []);
  const setDetailsDirty = useCallback((dirty: boolean) => setDirty(DETAILS_KEY, dirty), [setDirty]);
  const setSettingsDirty = useCallback((dirty: boolean) => setDirty(SETTINGS_KEY, dirty), [setDirty]);
  const [reshaping, setReshaping] = useState(0);
  const [discarding, setDiscarding] = useState(false);

  const controllerEdit = controller.edit;
  const edit = useCallback(
    async (ops: DraftOp[]): Promise<boolean> => {
      if (!ops.some(isLayoutOp)) return controllerEdit(ops);
      setReshaping((n) => n + 1);
      try {
        return await controllerEdit(ops);
      } finally {
        setReshaping((n) => n - 1);
      }
    },
    [controllerEdit],
  );

  const dirty = dirtyKeys.size > 0;
  const status = { saving, conflict, saveFailed, dirty };
  const unsaved = hasUnsavedWork(status);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const { doc, problems } = draft;
  const neverPublished = draft.baseVersionId === null;
  const busy = reshaping > 0;
  const lessonsFull = lessonLimit(doc.lessons.length);

  async function discard() {
    const warning = neverPublished
      ? "Discard this draft? The course has never been published, so everything in it is lost."
      : "Discard this draft? Every change since the last publish is lost. Learners keep the published version.";
    if (!confirm(warning)) return;
    setDiscarding(true);
    const discarded = await controller.discard();
    setDiscarding(false);
    if (discarded) {
      router.push("/author");
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-600">
          {BACK}
          <span>
            /{draft.slug} · {neverPublished ? "never published" : "editing a copy of the published version"}
          </span>
          <Link
            href={`/author/courses/${courseId}/preview`}
            prefetch={false}
            target="_blank"
            title="Opens in a new tab and shows the draft as last saved"
            className="font-semibold hover:underline"
            style={{ color: "var(--brand-primary)" }}
          >
            Preview as a learner ↗
          </Link>
        </div>
        <span className={`text-xs ${!saving && (conflict || saveFailed) ? "font-semibold text-rose-700" : "text-gray-500"}`} aria-live="polite">
          {saveStatusLabel(status)}
        </span>
      </div>

      {aiOrigin ? <AiDraftBanner origin={aiOrigin} /> : null}
      {conflict ? (
        <Banner tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              <strong>Someone else saved this draft first.</strong> Reload it to see their changes, then make yours again.
            </span>
            <Button size="sm" variant="outline" onClick={() => void controller.reload()}>
              Reload
            </Button>
          </div>
        </Banner>
      ) : null}
      {error ? (
        <Banner tone="error">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <button type="button" className="text-sm font-semibold underline" onClick={controller.dismissError}>
              Dismiss
            </button>
          </div>
        </Banner>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          <MetaForm meta={doc.meta} locked={conflict} edit={edit} onDirtyChange={setDetailsDirty} />
          <SettingsPanel meta={doc.meta} locked={conflict} edit={edit} onDirtyChange={setSettingsDirty} />
          {doc.lessons.map((lesson, index) => {
            const prev = doc.lessons[index - 1];
            const next = doc.lessons[index + 1];
            return (
              <LessonCard
                key={lesson.key}
                lesson={lesson}
                index={index}
                lessonCount={doc.lessons.length}
                previous={prev ? { key: prev.key, blockCount: prev.blocks.length } : null}
                next={next ? { key: next.key, blockCount: next.blocks.length } : null}
                busy={busy}
                locked={conflict}
                isOpen={isOpen}
                setOpen={setOpen}
                setDirty={setDirty}
                edit={edit}
              />
            );
          })}
          {doc.lessons.length === 0 ? <p className="text-sm text-gray-600">No lessons yet. Add the first one below.</p> : null}
          <AddLessonForm disabled={busy || conflict} limitReason={lessonsFull} onAdd={(lesson) => edit([{ op: "addLesson", lesson }])} />
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Publish</h2>
            <PublishPanel
              neverPublished={neverPublished}
              hasProblems={problems.length > 0}
              dirty={dirty}
              locked={conflict}
              onPublish={controller.publish}
            />
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <ProblemList problems={problems} />
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <VersionHistory courseId={courseId} baseVersionId={draft.baseVersionId} />
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-2">
            <p className="text-sm text-gray-700">
              {neverPublished
                ? "Throw this draft away. The course stays unpublished and starts again empty."
                : "Throw this draft away and start again from the published version."}
            </p>
            <Button size="sm" variant="danger" onClick={() => void discard()} disabled={conflict || discarding}>
              Discard draft
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
