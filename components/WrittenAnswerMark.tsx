"use client";

import { useState } from "react";
import {
  REVIEW_NOTE_MAX_CHARS,
  reviewText,
  statusText,
  type WrittenAnswerMark as Mark,
} from "@/lib/ai/grading/written-answer";

// One written answer's mark in the course player (slice A5b): its status, the
// marker's feedback as plain text, and a way to ask the instructor to look at
// it again, once. `marking` is true while an AI mark is still expected.
export default function WrittenAnswerMark({
  mark,
  marking = false,
  onAskForReview,
}: {
  mark: Mark;
  marking?: boolean;
  onAskForReview?: (note: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!onAskForReview) return;
    setSending(true);
    setError(null);
    try {
      await onAskForReview(note.trim() || null);
      setOpen(false);
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn't send your request. Try again in a moment.");
    } finally {
      setSending(false);
    }
  }

  const status = marking && mark.status === "awaiting_instructor" ? "Marking your answer…" : statusText(mark);
  const review = reviewText(mark.review);

  return (
    <div className="mt-2 space-y-2">
      <p className="font-semibold">{status}</p>
      {mark.feedbackMd ? <p className="whitespace-pre-wrap">{mark.feedbackMd}</p> : null}
      {review ? <p className="text-xs opacity-80">{review}</p> : null}
      {mark.canAskForReview && onAskForReview && !open ? (
        <button type="button" className="text-sm font-semibold underline" onClick={() => setOpen(true)}>
          Ask your instructor to look again
        </button>
      ) : null}
      {mark.canAskForReview && onAskForReview && open ? (
        <div className="space-y-2">
          <label className="block text-sm">
            Anything your instructor should know (optional)
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={REVIEW_NOTE_MAX_CHARS}
              rows={3}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white p-2 text-sm text-gray-900"
            />
          </label>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending}
              className="px-4 py-1.5 text-sm font-semibold rounded-md text-white disabled:opacity-40"
              style={{ backgroundColor: "var(--brand-primary)" }}
            >
              {sending ? "Sending…" : "Send request"}
            </button>
            <button type="button" className="text-sm underline" onClick={() => setOpen(false)} disabled={sending}>
              Cancel
            </button>
          </div>
          {error ? <p className="text-sm text-rose-700">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
