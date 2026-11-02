"use client";

import { useEffect, useState } from "react";
import Button from "@/components/Button";

// Per-slide feedback affordance. Unlike CourseFeedback (whole-course star
// rating, shown once at the end), this is scoped to the single block in front
// of the learner — the panel header states that scope explicitly. State resets
// whenever blockId changes so a draft never carries across slides.

interface Props {
  courseSlug: string;
  blockId: string;
  lessonNumber: number;
  lessonTitle: string;
  slideNumber: number;
  totalSlides: number;
}

interface BlockFeedbackPayload {
  blockFeedbackId: string;
  blockId: string;
  comment: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

type Status = "idle" | "loading" | "submitting" | "saved" | "error";

export default function SlideFeedback({
  courseSlug,
  blockId,
  lessonNumber,
  lessonTitle,
  slideNumber,
  totalSlides,
}: Props) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [comment, setComment] = useState("");
  const [existing, setExisting] = useState<BlockFeedbackPayload | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  // New slide — drop everything from the previous one.
  useEffect(() => {
    setOpen(false);
    setLoaded(false);
    setComment("");
    setExisting(null);
    setStatus("idle");
    setError(null);
  }, [blockId]);

  // Lazy-load any note this learner already left on this block, the first time
  // they open the panel.
  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    setStatus("loading");
    fetch(`/api/learner/block-feedback?blockId=${encodeURIComponent(blockId)}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { feedback: BlockFeedbackPayload | null }) => {
        if (cancelled) return;
        if (data.feedback) {
          setExisting(data.feedback);
          setComment(data.feedback.comment);
        }
        setLoaded(true);
        setStatus("idle");
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded(true);
        setStatus("idle");
      });
    return () => {
      cancelled = true;
    };
  }, [open, loaded, blockId]);

  async function submit() {
    const trimmed = comment.trim();
    if (trimmed.length === 0) {
      setError("Write a note before sending.");
      return;
    }
    setError(null);
    setStatus("submitting");
    try {
      const res = await fetch("/api/learner/block-feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courseSlug, blockId, comment: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not send your feedback.");
        setStatus("error");
        return;
      }
      const data = (await res.json()) as { feedback: BlockFeedbackPayload };
      setExisting(data.feedback);
      setStatus("saved");
    } catch {
      setError("Could not send your feedback.");
      setStatus("error");
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-800"
      >
        <span aria-hidden>💬</span>
        {existing ? "Edit your feedback on this slide" : "Feedback on this slide"}
      </button>
    );
  }

  const busy = status === "submitting" || status === "loading";

  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-800">
            Feedback on this slide
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            Lesson {lessonNumber}: {lessonTitle} · Slide {slideNumber} of{" "}
            {totalSlides}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close feedback"
          className="text-lg leading-none text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </div>

      {status === "saved" ? (
        <div className="mt-3">
          <p className="text-sm text-green-700">
            Thanks &mdash; noted for this slide.
          </p>
          <button
            type="button"
            onClick={() => setStatus("idle")}
            className="mt-2 text-xs font-medium text-gray-500 hover:text-gray-800"
          >
            Edit
          </button>
        </div>
      ) : (
        <>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Anything confusing, wrong, or missing on this slide?"
            maxLength={4000}
            rows={3}
            disabled={busy}
            className="mt-3 block w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--brand-primary)] disabled:bg-gray-100"
          />
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
          <div className="mt-2 flex items-center gap-3">
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={submit}
              disabled={busy || comment.trim().length === 0}
            >
              {status === "submitting"
                ? "Sending…"
                : existing
                  ? "Update"
                  : "Send"}
            </Button>
            {status === "loading" && (
              <span className="text-xs text-gray-400">Loading…</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
