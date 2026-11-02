"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Button from "@/components/Button";
import { Banner } from "./Banner";
import { callApi, ingestionUrl, type IngestionStatusBody } from "./api";
import { describeSource, describeWarning, isFinished, progressLabel, progressPercent } from "./ingestion-helpers";

const POLL_MS = 3000;

type Ingestion = IngestionStatusBody["ingestion"];

const BACK = (
  <Link href="/author" prefetch={false} className="text-sm font-semibold hover:underline" style={{ color: "var(--brand-primary)" }}>
    ← All courses
  </Link>
);

// Polls the job's status read until the job ends. Only reads: the draft it
// makes is opened, reviewed and published in the course editor.
export default function IngestionProgress({ ingestionId }: { ingestionId: string }) {
  const [ingestion, setIngestion] = useState<Ingestion | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const res = await callApi<IngestionStatusBody>(ingestionUrl(ingestionId), "GET");
      if (stopped) return;
      if (res.ok) {
        setIngestion(res.body.ingestion);
        setPollError(null);
        if (isFinished(res.body.ingestion.status)) return;
      } else if (res.status === 404) {
        setMissing(true);
        return;
      } else {
        setPollError(res.error);
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    }
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [ingestionId]);

  if (missing) {
    return (
      <div className="space-y-4">
        <Banner tone="error">This AI draft wasn&rsquo;t found. Check the link, or start a new one from your courses.</Banner>
        {BACK}
      </div>
    );
  }

  if (!ingestion) {
    return (
      <div className="space-y-2">
        <p className="text-gray-600">Checking on the draft…</p>
        {pollError ? <p className="text-sm text-rose-700">{pollError}</p> : null}
      </div>
    );
  }

  const percent = progressPercent(ingestion);
  return (
    <div className="max-w-2xl space-y-4">
      {BACK}
      <p className="text-gray-700">Drafting a course from {describeSource(ingestion.source)}.</p>

      {ingestion.status === "completed" && ingestion.courseId ? (
        <Banner tone="success">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Your draft is ready. Review every lesson before you publish it.</span>
            <Button size="sm" href={`/author/courses/${encodeURIComponent(ingestion.courseId)}`} prefetch={false}>
              Open the draft
            </Button>
          </div>
        </Banner>
      ) : ingestion.status === "failed" || ingestion.status === "cancelled" ? (
        <Banner tone="error">
          <div className="space-y-2">
            <p>
              {progressLabel(ingestion)}
              {ingestion.error ? ` ${ingestion.error}` : ""}
            </p>
            <Button size="sm" variant="outline" href="/author/ingestions/new" prefetch={false}>
              Try again
            </Button>
          </div>
        </Banner>
      ) : (
        <div className="space-y-2 rounded-xl border border-gray-200 bg-white p-4">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-gray-200"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="h-full rounded-full transition-all" style={{ width: `${percent}%`, backgroundColor: "var(--brand-primary)" }} />
          </div>
          <p className="text-sm text-gray-700" aria-live="polite">
            {progressLabel(ingestion)}
          </p>
          {ingestion.error ? <p className="text-sm text-gray-600">The last try hit a problem and will be retried: {ingestion.error}</p> : null}
          <p className="text-xs text-gray-500">This takes a few minutes. You can leave this page; the draft carries on.</p>
        </div>
      )}

      {pollError ? <p className="text-sm text-rose-700">Couldn&rsquo;t check just now ({pollError}). Trying again.</p> : null}

      {ingestion.warnings.length > 0 ? (
        <div className="space-y-1 text-sm text-gray-700">
          <p className="font-semibold">Left out of the draft because they didn&rsquo;t pass the block checks:</p>
          <ul className="list-disc space-y-1 pl-5">
            {ingestion.warnings.map((w) => (
              <li key={`${w.lesson}-${w.position}`}>{describeWarning(w)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
