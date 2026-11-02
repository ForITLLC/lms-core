"use client";

import { useState } from "react";
import { callApi } from "@/components/author/api";
import { MARK_FEEDBACK_MAX_CHARS, MARK_REASON_MAX_CHARS } from "@/lib/ai/grading/written-answer";

// The staff marking queue (slice A5b): each written answer that needs an
// instructor, with its question, rubric, the learner's answer, the AI's
// provisional mark and any review the learner asked for. Confirm takes the
// AI's mark; Override sets the instructor's own with a reason. Both post to
// /api/author/grades, which checks the tenant and writes the audit event.
// Learner text and model feedback are shown as plain text, never as markup.

export interface QueueItem {
  attemptId: string;
  questionId: string;
  learnerName: string;
  waitingSince: string | null;
  courseTitle: string | null;
  lessonTitle: string | null;
  questionNumber: number;
  promptMd: string;
  rubricMd: string;
  maxScore: number;
  answer: string;
  aiGradeId: string | null;
  aiScore: number | null;
  aiMaxScore: number | null;
  aiFeedbackMd: string | null;
  instructorScore: number | null;
  review: { note: string | null; requestedAt: string } | null;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "unknown");

export default function GradingQueue({ items, total }: { items: QueueItem[]; total: number }) {
  const [marked, setMarked] = useState<Record<string, string>>({});
  const key = (item: QueueItem) => `${item.attemptId}:${item.questionId}`;
  const left = items.filter((item) => !(key(item) in marked));

  return (
    <div className="space-y-6">
      <p className="text-gray-700">
        {total === 0
          ? "No written answers are waiting for you."
          : `${total} written ${total === 1 ? "answer is" : "answers are"} waiting for an instructor${total > items.length ? `; the ${items.length} waiting longest are shown` : ""}.`}
      </p>
      {Object.values(marked).map((message, i) => (
        <p key={i} className="text-sm text-emerald-700">
          {message}
        </p>
      ))}
      {left.map((item) => (
        <QueueCard
          key={key(item)}
          item={item}
          onMarked={(message) => setMarked((m) => ({ ...m, [key(item)]: message }))}
        />
      ))}
    </div>
  );
}

function QueueCard({ item, onMarked }: { item: QueueItem; onMarked: (message: string) => void }) {
  const [score, setScore] = useState(item.aiScore !== null ? String(item.aiScore) : "");
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    const result = await callApi<{ gradeId: string }>("/api/author/grades", "POST", body);
    setBusy(false);
    if (result.ok) onMarked(done);
    else setError(result.error);
  }

  function confirm() {
    if (!item.aiGradeId) return;
    void post(
      { action: "confirm", attemptId: item.attemptId, questionId: item.questionId, gradeId: item.aiGradeId },
      `Confirmed the AI's mark for ${item.learnerName}.`,
    );
  }

  function override() {
    const value = Number(score);
    if (!Number.isInteger(value) || value < 0 || value > item.maxScore) {
      setError(`The score must be a whole number from 0 to ${item.maxScore}.`);
      return;
    }
    if (reason.trim() === "") {
      setError("Give a reason for overriding the mark.");
      return;
    }
    void post(
      {
        action: "override",
        attemptId: item.attemptId,
        questionId: item.questionId,
        score: value,
        reason: reason.trim(),
        feedbackMd: feedback.trim() || null,
      },
      `Marked ${item.learnerName}'s answer ${value}/${item.maxScore}.`,
    );
  }

  const where = [item.courseTitle, item.lessonTitle, `Question ${item.questionNumber}`].filter(Boolean).join(" · ");

  return (
    <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900">{item.learnerName}</h2>
        <p className="text-xs text-gray-500">
          {where} · waiting since {when(item.waitingSince)}
        </p>
      </header>

      <Field label="Question">{item.promptMd}</Field>
      <Field label="Rubric">{item.rubricMd}</Field>
      <Field label="Learner's answer" strong>
        {item.answer}
      </Field>

      {item.review ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">
            The learner asked you to look again ({when(item.review.requestedAt)})
            {item.instructorScore !== null ? `; the current mark is ${item.instructorScore}/${item.maxScore}` : ""}.
          </p>
          {item.review.note ? <p className="mt-1 whitespace-pre-wrap">{item.review.note}</p> : null}
        </div>
      ) : null}

      {item.aiGradeId ? (
        <div className="rounded-md border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900">
          <p className="font-semibold">
            AI mark (provisional): {item.aiScore}/{item.aiMaxScore ?? item.maxScore}
          </p>
          {item.aiFeedbackMd ? <p className="mt-1 whitespace-pre-wrap">{item.aiFeedbackMd}</p> : null}
        </div>
      ) : (
        <p className="text-sm text-gray-600">No AI mark. Mark this answer yourself.</p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        {item.aiGradeId ? (
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
            style={{ backgroundColor: "var(--brand-primary)" }}
          >
            Confirm AI mark
          </button>
        ) : null}
      </div>

      <fieldset className="space-y-2 border-t border-gray-100 pt-4">
        <legend className="text-sm font-semibold text-gray-900">{item.aiGradeId ? "Or override" : "Your mark"}</legend>
        <label className="block text-sm text-gray-700">
          Score (0 to {item.maxScore})
          <input
            type="number"
            min={0}
            max={item.maxScore}
            step={1}
            value={score}
            onChange={(e) => setScore(e.target.value)}
            className="ml-2 w-20 rounded-md border border-gray-300 p-1"
          />
        </label>
        <label className="block text-sm text-gray-700">
          Reason (required; the learner doesn&rsquo;t see it)
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={MARK_REASON_MAX_CHARS}
            rows={2}
            className="mt-1 w-full rounded-md border border-gray-300 p-2"
          />
        </label>
        <label className="block text-sm text-gray-700">
          Feedback for the learner (optional)
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            maxLength={MARK_FEEDBACK_MAX_CHARS}
            rows={3}
            className="mt-1 w-full rounded-md border border-gray-300 p-2"
          />
        </label>
        <button
          type="button"
          onClick={override}
          disabled={busy}
          className="rounded-md border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-900 disabled:opacity-40"
        >
          {item.aiGradeId ? "Override with this mark" : "Save mark"}
        </button>
      </fieldset>

      {error ? <p className="text-sm text-rose-700">{error}</p> : null}
    </section>
  );
}

function Field({ label, strong = false, children }: { label: string; strong?: boolean; children: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 whitespace-pre-wrap text-sm ${strong ? "rounded-md bg-gray-50 p-3 text-gray-900" : "text-gray-700"}`}>
        {children}
      </p>
    </div>
  );
}
