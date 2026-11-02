"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import Button from "@/components/Button";

interface Props {
  courseSlug: string;
  courseTitle: string;
}

interface FeedbackPayload {
  feedbackId: string;
  rating: number;
  comment: string | null;
  submittedAt: string;
  updatedAt: string;
}

type Status = "idle" | "loading" | "submitting" | "saved" | "error";

export default function CourseFeedback({ courseSlug, courseTitle }: Props) {
  const [rating, setRating] = useState<number>(0);
  const [hoverRating, setHoverRating] = useState<number>(0);
  const [comment, setComment] = useState<string>("");
  const [existing, setExisting] = useState<FeedbackPayload | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadExisting() {
      try {
        const res = await fetch(
          `/api/learner/feedback?courseSlug=${encodeURIComponent(courseSlug)}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          if (!cancelled) setStatus("idle");
          return;
        }
        const data = (await res.json()) as { feedback: FeedbackPayload | null };
        if (cancelled) return;
        if (data.feedback) {
          setExisting(data.feedback);
          setRating(data.feedback.rating);
          setComment(data.feedback.comment ?? "");
        }
        setStatus("idle");
      } catch {
        if (!cancelled) setStatus("idle");
      }
    }
    loadExisting();
    return () => {
      cancelled = true;
    };
  }, [courseSlug]);

  async function submit() {
    if (rating < 1 || rating > 5) {
      setError("Pick a rating from 1 to 5 stars.");
      return;
    }
    setError(null);
    setStatus("submitting");
    try {
      const res = await fetch("/api/learner/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          courseSlug,
          rating,
          comment: comment.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not save your feedback.");
        setStatus("error");
        return;
      }
      const data = (await res.json()) as { feedback: FeedbackPayload };
      setExisting(data.feedback);
      setStatus("saved");
    } catch {
      setError("Could not save your feedback.");
      setStatus("error");
    }
  }

  const display = hoverRating || rating;
  const submitting = status === "submitting";
  const previouslyRated = existing !== null;

  return (
    <Card variant="white" padding="lg" className="mt-8">
      <h3
        className="text-lg font-semibold"
        style={{ color: "var(--brand-primary)" }}
      >
        How was the whole course?
      </h3>
      <p className="mt-1 text-sm text-gray-600">
        This rates {courseTitle} as a whole. For notes on a specific slide, use
        the 💬 feedback link while learning. Your rating is visible to the
        course author.
      </p>

      {previouslyRated && existing && (
        <p className="mt-2 text-xs text-gray-500">
          You previously rated this {existing.rating} star
          {existing.rating === 1 ? "" : "s"} — submit again to update.
        </p>
      )}

      <div
        className="mt-4 flex items-center gap-1"
        role="radiogroup"
        aria-label="Course rating"
      >
        {[1, 2, 3, 4, 5].map((n) => {
          const filled = n <= display;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} star${n === 1 ? "" : "s"}`}
              disabled={submitting}
              onClick={() => setRating(n)}
              onMouseEnter={() => setHoverRating(n)}
              onMouseLeave={() => setHoverRating(0)}
              onFocus={() => setHoverRating(n)}
              onBlur={() => setHoverRating(0)}
              className="text-3xl leading-none transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-[color:var(--brand-primary)] rounded"
              style={{
                color: filled ? "var(--brand-accent, #f5b400)" : "#d1d5db",
              }}
            >
              {filled ? "★" : "☆"}
            </button>
          );
        })}
        <span className="ml-3 text-sm text-gray-500">
          {rating > 0 ? `${rating} / 5` : "Select a rating"}
        </span>
      </div>

      <label className="mt-4 block">
        <span className="text-sm font-medium text-gray-700">
          Comment (optional)
        </span>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="What worked? What didn't?"
          maxLength={4000}
          rows={4}
          disabled={submitting}
          className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--brand-primary)] disabled:bg-gray-50"
        />
      </label>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {status === "saved" && (
        <p className="mt-2 text-sm text-green-700">
          Thanks &mdash; your feedback was saved.
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button
          type="button"
          variant="primary"
          onClick={submit}
          disabled={submitting || rating < 1}
        >
          {submitting
            ? "Saving…"
            : previouslyRated
              ? "Update feedback"
              : "Submit feedback"}
        </Button>
      </div>
    </Card>
  );
}
