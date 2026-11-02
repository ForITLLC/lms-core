"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftOp } from "@/lib/builder/draft-ops";
import type { DraftDoc, PublishProblem } from "@/lib/schema/draft";
import {
  callApi,
  draftUrl,
  problemsIn,
  publishUrl,
  type DraftEditBody,
  type DraftRecordBody,
  type PublishBody,
} from "./api";

export interface LoadedDraft {
  draftId: string;
  slug: string;
  baseVersionId: string | null;
  revision: number;
  doc: DraftDoc;
  problems: PublishProblem[];
}

export type DraftPhase =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "editing" }
  | { kind: "published"; versionNumber: number };

export type PublishOutcome = { ok: true } | { ok: false; message: string };

const GONE = "This draft was published or discarded somewhere else. Open the course again to keep editing.";

function fromRecord(body: DraftRecordBody): LoadedDraft {
  const { draftId, slug, baseVersionId, revision, doc } = body.draft;
  return { draftId, slug, baseVersionId, revision, doc, problems: body.problems };
}

// One draft held against the server. Every save carries the draft id and the
// revision the last save returned, so saves run one at a time in the order they
// were made; after a 409 nothing more is sent until the draft is reloaded.
// saveFailed stays set from a failed save until the next one succeeds.
export function useDraft(courseId: string) {
  const [phase, setPhase] = useState<DraftPhase>({ kind: "loading" });
  const [draft, setDraft] = useState<LoadedDraft | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [pending, setPending] = useState(0);
  const draftId = useRef("");
  const revision = useRef(0);
  const stale = useRef(false);
  const failures = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(async () => {
      setPending((n) => n + 1);
      try {
        return await task();
      } finally {
        setPending((n) => n - 1);
      }
    });
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  const accept = useCallback((loaded: LoadedDraft) => {
    draftId.current = loaded.draftId;
    revision.current = loaded.revision;
    stale.current = false;
    setConflict(false);
    setError(null);
    setSaveFailed(false);
    setDraft(loaded);
    setPhase({ kind: "editing" });
  }, []);

  const markStale = useCallback(() => {
    stale.current = true;
    setConflict(true);
  }, []);

  const gone = useCallback(() => {
    stale.current = true;
    setDraft(null);
    setPhase({ kind: "failed", message: GONE });
  }, []);

  const open = useCallback(
    () =>
      enqueue(async () => {
        setPhase({ kind: "loading" });
        const res = await callApi<DraftRecordBody>(draftUrl(courseId), "POST");
        if (res.ok) accept(fromRecord(res.body));
        else setPhase({ kind: "failed", message: res.status === 404 ? "This course isn't one of your tenant's courses." : res.error });
      }),
    [accept, courseId, enqueue],
  );

  useEffect(() => {
    void open();
  }, [open]);

  const reload = useCallback(
    () =>
      enqueue(async () => {
        const res = await callApi<DraftRecordBody>(draftUrl(courseId), "GET");
        if (res.ok) accept(fromRecord(res.body));
        else if (res.status === 404) gone();
        else setError(res.error);
      }),
    [accept, courseId, enqueue, gone],
  );

  const edit = useCallback(
    (ops: DraftOp[]): Promise<boolean> =>
      enqueue(async () => {
        if (stale.current) return false;
        const res = await callApi<DraftEditBody>(draftUrl(courseId), "PATCH", {
          draftId: draftId.current,
          revision: revision.current,
          ops,
        });
        if (res.ok) {
          const { revision: next, doc, problems } = res.body;
          const id = res.body.draftId || draftId.current;
          draftId.current = id;
          revision.current = next;
          setError(null);
          setSaveFailed(false);
          setDraft((d) => d && { ...d, draftId: id, revision: next, doc, problems });
          return true;
        }
        failures.current += 1;
        if (res.status === 409) markStale();
        else if (res.status === 404) gone();
        else {
          setError(res.error);
          setSaveFailed(true);
        }
        return false;
      }),
    [courseId, enqueue, gone, markStale],
  );

  // A save queued just before the click (a field saving on blur) runs first;
  // if it fails, nothing is published until the author has seen why.
  const publish = useCallback(
    (changeNote: string): Promise<PublishOutcome> => {
      const failuresAtClick = failures.current;
      return enqueue(async (): Promise<PublishOutcome> => {
        if (stale.current) return { ok: false, message: "Reload the draft before publishing." };
        if (failures.current !== failuresAtClick) {
          return { ok: false, message: "A change made just before publishing didn't save, so nothing was published. Check the error, then publish again." };
        }
        const note = changeNote.trim();
        const res = await callApi<PublishBody>(publishUrl(courseId), "POST", {
          draftId: draftId.current,
          revision: revision.current,
          ...(note ? { changeNote: note } : {}),
        });
        if (res.ok) {
          setDraft(null);
          setPhase({ kind: "published", versionNumber: res.body.versionNumber });
          return { ok: true };
        }
        if (res.code === "draft_conflict") markStale();
        else if (res.status === 404) {
          gone();
          return { ok: false, message: GONE };
        }
        const problems = problemsIn(res.body);
        if (problems) setDraft((d) => d && { ...d, problems });
        return { ok: false, message: res.error };
      });
    },
    [courseId, enqueue, gone, markStale],
  );

  // Queued like a save, so it carries the revision of any edit made before it;
  // the server refuses a stale revision with a 409.
  const discard = useCallback(
    (): Promise<boolean> =>
      enqueue(async () => {
        if (stale.current) return false;
        const query = new URLSearchParams({ draftId: draftId.current, revision: String(revision.current) });
        const res = await callApi<{ ok: true }>(`${draftUrl(courseId)}?${query.toString()}`, "DELETE");
        if (res.ok || res.status === 404) {
          stale.current = true;
          return true;
        }
        if (res.status === 409) markStale();
        else setError(res.error);
        return false;
      }),
    [courseId, enqueue, markStale],
  );

  return {
    phase,
    draft,
    conflict,
    error,
    saveFailed,
    saving: pending > 0,
    open,
    reload,
    edit,
    publish,
    discard,
    dismissError: () => setError(null),
  };
}

export type DraftController = ReturnType<typeof useDraft>;
