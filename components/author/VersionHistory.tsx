"use client";

import { useEffect, useState } from "react";
import { callApi, versionsUrl, type VersionHistoryBody } from "./api";
import { versionCounts } from "./draft-helpers";

type State = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; history: VersionHistoryBody };

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// Read only: the MVP has no restore or rollback (decision 6).
export default function VersionHistory({ courseId, baseVersionId }: { courseId: string; baseVersionId: string | null }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    void callApi<VersionHistoryBody>(versionsUrl(courseId), "GET").then((res) => {
      if (live) setState(res.ok ? { kind: "loaded", history: res.body } : { kind: "failed", message: res.error });
    });
    return () => {
      live = false;
    };
  }, [courseId, baseVersionId, attempt]);

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Version history</h2>
      {state.kind === "loading" ? <p className="text-sm text-gray-500">Loading…</p> : null}
      {state.kind === "failed" ? (
        <div className="space-y-1">
          <p className="text-sm text-rose-700">{state.message}</p>
          <button type="button" className="text-sm font-semibold underline" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : null}
      {state.kind === "loaded" ? <Versions history={state.history} baseVersionId={baseVersionId} /> : null}
    </div>
  );
}

function Versions({ history, baseVersionId }: { history: VersionHistoryBody; baseVersionId: string | null }) {
  if (history.versions.length === 0) return <p className="text-sm text-gray-600">Not published yet.</p>;
  const baseBehind = baseVersionId !== null && baseVersionId !== history.currentVersionId;
  return (
    <ol className="max-h-80 space-y-2 overflow-y-auto">
      {history.versions.map((v) => (
        <li key={v.versionId} className="rounded-md border border-gray-200 p-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-gray-900">Version {v.versionNumber}</span>
            {v.isCurrent ? (
              <span className="rounded-full px-2 py-0.5 text-xs font-semibold text-white" style={{ backgroundColor: "var(--brand-primary)" }}>
                Live
              </span>
            ) : null}
            {baseBehind && v.versionId === baseVersionId ? <span className="text-xs text-amber-800">Your draft started from this one</span> : null}
          </div>
          <p className="text-xs text-gray-500">
            {when(v.publishedAt)} · {v.publishedBy}
          </p>
          {v.changeNote ? <p className="mt-1 whitespace-pre-wrap break-words text-gray-700">{v.changeNote}</p> : null}
          <p className="mt-1 text-xs text-gray-500">{versionCounts(v)}</p>
        </li>
      ))}
    </ol>
  );
}
