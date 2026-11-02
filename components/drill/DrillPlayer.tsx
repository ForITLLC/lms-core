"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import Markdown from "@/components/Markdown";
import Button from "@/components/Button";
import { choiceState, type ChoiceState } from "@/lib/drill/choice-state";
import type { DrillItemView, DrillTodayView } from "@/lib/drill/service";

type Response = string | boolean | string[];
type Confidence = 1 | 2 | 3;

const CONFIDENCE: Array<{ value: Confidence; label: string; hint: string }> = [
  { value: 1, label: "Guessing", hint: "+10 if right" },
  { value: 2, label: "Fairly sure", hint: "+10 if right" },
  { value: 3, label: "Certain", hint: "+15 if right, −5 if wrong" },
];

// A selected row is a light brand tint plus a brand ring, never brand fill:
// choice labels are Markdown, and `prose` forces its own (dark) text colour,
// so text on a brand background was unreadable.
const BRAND_TINT: CSSProperties = { backgroundColor: "color-mix(in srgb, var(--brand-primary) 8%, white)" };
const BRAND_FILL: CSSProperties = { backgroundColor: "var(--brand-primary)", borderColor: "var(--brand-primary)" };
const BRAND_RING = "ring-2 ring-[color:var(--brand-primary)] border-transparent";

type RowLook = "idle" | "selected" | ChoiceState;

const ROW: Record<RowLook, { row: string; rowStyle?: CSSProperties; badge: string; badgeStyle?: CSSProperties }> = {
  idle: {
    row: "bg-white border-gray-300 text-gray-800 hover:bg-gray-50 hover:border-gray-400",
    badge: "bg-gray-100 border-gray-300 text-gray-700",
  },
  selected: {
    row: `${BRAND_RING} text-gray-900`,
    rowStyle: BRAND_TINT,
    badge: "border-transparent text-white",
    badgeStyle: BRAND_FILL,
  },
  correct: {
    row: "bg-green-50 border-transparent ring-2 ring-green-500 text-gray-900",
    badge: "bg-green-600 border-transparent text-white",
  },
  wrong: {
    row: "bg-red-50 border-transparent ring-2 ring-red-400 text-gray-900",
    badge: "bg-red-500 border-transparent text-white",
  },
  missed: {
    row: "bg-green-50 border-green-500 border-dashed text-gray-900",
    badge: "bg-white border-green-500 text-green-700",
  },
  neutral: {
    row: "bg-white border-gray-200 text-gray-500",
    badge: "bg-gray-50 border-gray-200 text-gray-400",
  },
};

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

function statChips(view: DrillTodayView): Array<{ label: string; value: string }> {
  const s = view.stats;
  return [
    { label: "Streak", value: `${s.currentStreak} 🔥` },
    { label: "Points", value: String(s.totalPoints) },
    { label: "Freezes", value: `${s.freezesAvailable} ❄️` },
    { label: "Accuracy", value: s.accuracyPct === null ? "—" : `${s.accuracyPct}%` },
    { label: "Calibration", value: s.calibrationPct === null ? "—" : `${s.calibrationPct}%` },
  ];
}

function Stats({ view, layout }: { view: DrillTodayView; layout: "row" | "column" }) {
  const chips = statChips(view);
  if (layout === "column") {
    return (
      <dl className="rounded-lg bg-white border border-gray-200 divide-y divide-gray-100">
        {chips.map((c) => (
          <div key={c.label} className="flex items-center justify-between px-4 py-3">
            <dt className="text-xs uppercase tracking-wide text-gray-500">{c.label}</dt>
            <dd className="text-lg font-bold text-gray-900 leading-tight">{c.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className="flex flex-wrap gap-2 mb-6">
      {chips.map((c) => (
        <div key={c.label} className="rounded-md bg-white border border-gray-200 px-3 py-2 min-w-[6.5rem]">
          <dt className="text-[11px] uppercase tracking-wide text-gray-500">{c.label}</dt>
          <dd className="text-lg font-bold text-gray-900 leading-tight">{c.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ProgressDots({ view, current }: { view: DrillTodayView; current: number }) {
  return (
    <ol className="flex gap-2 mb-4" aria-label="Progress">
      {view.items.map((it, i) => {
        const a = it.answered;
        const cls = a
          ? a.correct
            ? "bg-green-500"
            : "bg-red-400"
          : i === current
            ? "ring-2 ring-offset-1 ring-[color:var(--brand-primary)]"
            : "bg-gray-300";
        return (
          <li
            key={it.slot}
            className={`h-2.5 w-8 lg:w-12 rounded-full ${cls}`}
            style={!a && i === current ? { backgroundColor: "var(--brand-primary)" } : undefined}
            aria-label={`Question ${i + 1}${a ? (a.correct ? " correct" : " incorrect") : ""}`}
          />
        );
      })}
    </ol>
  );
}

function ChoiceRow({
  id,
  look,
  disabled,
  onClick,
  children,
}: {
  id: string;
  look: RowLook;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const r = ROW[look];
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={look === "selected"}
      className={`w-full text-left rounded-lg border px-4 py-3 lg:px-5 lg:py-4 flex gap-3 lg:gap-4 items-start transition-colors disabled:cursor-default ${r.row}`}
      style={r.rowStyle}
    >
      <span
        className={`flex-shrink-0 h-7 w-7 rounded-full border flex items-center justify-center font-mono text-sm font-semibold uppercase ${r.badge}`}
        style={r.badgeStyle}
        aria-hidden="true"
      >
        {id}
      </span>
      <span className="flex-1 min-w-0 pt-0.5">{children}</span>
    </button>
  );
}

function Choices({
  item,
  value,
  onChange,
  disabled,
}: {
  item: DrillItemView;
  value: Response | null;
  onChange: (r: Response) => void;
  disabled: boolean;
}) {
  const q = item.question;
  const reveal = item.answered?.reveal ?? null;
  const lookFor = (id: string, active: boolean): RowLook =>
    reveal ? choiceState(reveal, value, id) : active ? "selected" : "idle";

  if (q.kind === "tf") {
    return (
      <div className="grid grid-cols-2 gap-3">
        {[true, false].map((v) => (
          <ChoiceRow
            key={String(v)}
            id={v ? "T" : "F"}
            look={lookFor(String(v), value === v)}
            disabled={disabled}
            onClick={() => onChange(v)}
          >
            <span className="font-semibold">{v ? "True" : "False"}</span>
          </ChoiceRow>
        ))}
      </div>
    );
  }
  if (!("choices" in q)) return null;
  const multi = q.kind === "multi";
  const selected = multi ? (Array.isArray(value) ? value : []) : typeof value === "string" ? value : null;
  return (
    <ul className="space-y-2 lg:space-y-3">
      {q.choices.map((c) => {
        const active = multi ? (selected as string[]).includes(c.id) : selected === c.id;
        return (
          <li key={c.id}>
            <ChoiceRow
              id={c.id}
              look={lookFor(c.id, active)}
              disabled={disabled}
              onClick={() => {
                if (!multi) return onChange(c.id);
                const cur = selected as string[];
                onChange(cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id]);
              }}
            >
              <Markdown>{c.label}</Markdown>
            </ChoiceRow>
          </li>
        );
      })}
      {multi && !reveal ? <li className="text-xs text-gray-500">Select every correct answer.</li> : null}
    </ul>
  );
}

function Outcome({ item, value }: { item: DrillItemView; value: Response | null }) {
  const a = item.answered;
  if (!a) return null;
  const q = item.question;
  const correctLabel = (() => {
    const r = a.reveal;
    if (r.kind === "tf") return r.correct ? "True" : "False";
    if (!("choices" in q)) return "";
    const ids = r.kind === "multi" ? r.correct : r.kind === "short" ? [] : [r.correct];
    return q.choices
      .filter((c) => ids.includes(c.id))
      .map((c) => `${c.id.toUpperCase()}. ${c.label}`)
      .join(" · ");
  })();
  const yours = (() => {
    const v = value ?? a.response;
    if (typeof v === "boolean") return v ? "True" : "False";
    if (Array.isArray(v)) return v.map((x) => x.toUpperCase()).join(", ");
    return typeof v === "string" ? v.toUpperCase() : "";
  })();
  return (
    <div
      className={`mt-5 rounded-lg border p-4 lg:p-5 ${
        a.correct ? "bg-green-50 border-green-300" : "bg-red-50 border-red-300"
      }`}
    >
      <p className="font-semibold text-gray-900">
        {a.correct ? "Correct" : "Not quite"} · {a.points >= 0 ? "+" : ""}
        {a.points} pts
        {!a.correct && a.confidence === 3 ? " (certain and wrong costs 5)" : ""}
      </p>
      {!a.correct ? (
        <p className="text-sm text-gray-700 mt-1">
          You answered <span className="font-mono">{yours}</span>. Correct: {correctLabel}
        </p>
      ) : null}
      {a.explanationMd ? (
        <div className="mt-3 text-sm text-gray-800">
          <Markdown>{a.explanationMd}</Markdown>
        </div>
      ) : null}
      {a.sourceHref ? (
        <p className="mt-3 text-sm">
          <Link href={a.sourceHref} className="underline" style={{ color: "var(--brand-primary)" }}>
            Review the course{item.courseTitle ? `: ${item.courseTitle}` : ""}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function Summary({ view }: { view: DrillTodayView }) {
  const s = view.stats;
  return (
    <div className="rounded-lg bg-white border border-gray-200 p-6 lg:p-10 text-center max-w-2xl mx-auto">
      <p className="text-3xl mb-2" aria-hidden="true">🎯</p>
      <h2 className="text-xl lg:text-2xl font-semibold" style={{ color: "var(--brand-primary)" }}>
        Done for today
      </h2>
      <p className="mt-2 text-gray-700">
        {view.correctCount} of {view.totalCount} correct · {view.points} points today
      </p>
      <p className="mt-1 text-gray-700">
        {s.currentStreak}-day streak
        {s.currentStreak === s.longestStreak && s.longestStreak > 1 ? " — your best yet" : ""}
        {s.freezesAvailable > 0 ? ` · ${s.freezesAvailable} freeze${s.freezesAvailable === 1 ? "" : "s"} banked` : ""}
      </p>
      {s.calibrationPct !== null ? (
        <p className="mt-3 text-sm text-gray-500">
          When you say &ldquo;certain&rdquo; you are right {s.calibrationPct}% of the time (last 30 days).
        </p>
      ) : null}
      <p className="mt-4 text-sm text-gray-500">Weekends never break a streak. See you next workday.</p>
      <div className="mt-5">
        <Button href="/dashboard" variant="outline">Back to dashboard</Button>
      </div>
    </div>
  );
}

function ScoringNote() {
  return (
    <div className="rounded-lg bg-white border border-gray-200 p-4 text-sm text-gray-600 space-y-2">
      <p className="font-semibold text-gray-800">How scoring works</p>
      <p>Right answer: +10. Right and &ldquo;certain&rdquo;: +15. Wrong and &ldquo;certain&rdquo;: −5.</p>
      <p>Finish all five to keep the streak. Every 7-day streak banks a freeze that covers a missed day.</p>
    </div>
  );
}

// Passages (reading comprehension, data sufficiency set-ups) read better
// beside their choices on a wide screen; short stems stay stacked.
const LONG_PROMPT_CHARS = 400;

export default function DrillPlayer() {
  const [view, setView] = useState<DrillTodayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [response, setResponse] = useState<Response | null>(null);
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const shownAt = useRef<number>(Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/learner/drill/today?tz=${encodeURIComponent(browserTimeZone())}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const v = (await res.json()) as DrillTodayView;
      setView(v);
      const first = v.items.findIndex((it) => it.answered === null);
      setIndex(first === -1 ? v.items.length : first);
      shownAt.current = Date.now();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load today's drill");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const item = view?.items[index] ?? null;
  const answered = item?.answered ?? null;

  const canSubmit = useMemo(() => {
    if (!item || answered || submitting || confidence === null || response === null) return false;
    if (Array.isArray(response)) return response.length > 0;
    return true;
  }, [item, answered, submitting, confidence, response]);

  const submit = useCallback(async () => {
    if (!view?.sessionId || !item || confidence === null || response === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/learner/drill/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: view.sessionId,
          slot: item.slot,
          response,
          confidence,
          // The API takes at most an hour; a tab left open on a question would otherwise 400 for good.
          responseMs: Math.min(3_600_000, Math.max(0, Date.now() - shownAt.current)),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setView((await res.json()) as DrillTodayView);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit");
    } finally {
      setSubmitting(false);
    }
  }, [view, item, confidence, response]);

  const next = useCallback(() => {
    if (!view) return;
    const after = view.items.findIndex((it, i) => i > index && it.answered === null);
    setIndex(after === -1 ? view.items.length : after);
    setResponse(null);
    setConfidence(null);
    shownAt.current = Date.now();
  }, [view, index]);

  if (error && !view) {
    return (
      <div className="rounded-md bg-red-50 border border-red-300 p-4 text-red-800">
        {error}{" "}
        <button type="button" className="underline" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  if (!view) return <p className="text-gray-500">Loading today&rsquo;s drill…</p>;

  if (view.empty) {
    return (
      <div>
        <Stats view={view} layout="row" />
        <div className="rounded-lg bg-white border border-gray-200 p-6 lg:p-10 text-center max-w-2xl mx-auto">
          <p className="text-3xl mb-2" aria-hidden="true">🧠</p>
          <h2 className="text-xl font-semibold" style={{ color: "var(--brand-primary)" }}>
            Nothing to drill yet
          </h2>
          <p className="mt-2 text-gray-700 max-w-prose mx-auto">
            The daily drill pulls questions from courses you have completed and adds one fresh reasoning
            puzzle. Finish a course to unlock it.
          </p>
          <div className="mt-5">
            <Button href="/learn">Browse courses</Button>
          </div>
        </div>
      </div>
    );
  }

  const allAnswered = view.items.every((it) => it.answered !== null);
  const longPrompt = item !== null && item.question.promptMd.length > LONG_PROMPT_CHARS;
  const currentValue = (response ?? answered?.response ?? null) as Response | null;

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-8 xl:grid-cols-[minmax(0,1fr)_18rem] xl:gap-10">
      <div className="min-w-0">
        <div className="lg:hidden">
          <Stats view={view} layout="row" />
        </div>
        <ProgressDots view={view} current={index} />
        {allAnswered && !item ? (
          <Summary view={view} />
        ) : item ? (
          <div className="rounded-lg bg-white border border-gray-200 p-5 sm:p-6 lg:p-8">
            <p className="text-xs uppercase tracking-wide text-gray-500 mb-3 lg:mb-4">
              {index + 1} of {view.items.length} ·{" "}
              {item.source === "reasoning"
                ? `Reasoning · ${item.category?.replace(/-/g, " ") ?? ""}`
                : `Recall · ${item.courseTitle ?? "course"}`}
            </p>
            <div className={longPrompt ? "xl:grid xl:grid-cols-2 xl:gap-10" : undefined}>
              <div className={`text-gray-900 mb-5 ${longPrompt ? "xl:mb-0" : ""}`}>
                <Markdown size="lg">{item.question.promptMd}</Markdown>
              </div>
              <div className="min-w-0">
                <Choices item={item} value={currentValue} onChange={setResponse} disabled={answered !== null || submitting} />

                {answered === null ? (
                  <div className="mt-5 lg:mt-6">
                    <p className="text-sm font-medium text-gray-700 mb-2">How sure are you?</p>
                    <div className="flex flex-wrap gap-2">
                      {CONFIDENCE.map((c) => {
                        const active = confidence === c.value;
                        return (
                          <button
                            key={c.value}
                            type="button"
                            onClick={() => setConfidence(c.value)}
                            aria-pressed={active}
                            className={`rounded-md border px-3 py-2 lg:px-4 text-sm font-medium transition-colors ${
                              active ? `${BRAND_RING} text-gray-900` : "bg-white border-gray-300 text-gray-800 hover:bg-gray-50"
                            }`}
                            style={active ? BRAND_TINT : undefined}
                            title={c.hint}
                          >
                            {c.label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-5 flex flex-wrap items-center gap-3">
                      <Button onClick={() => void submit()} disabled={!canSubmit}>
                        {submitting ? "Checking…" : "Submit"}
                      </Button>
                      <span className="text-xs text-gray-500">No hints until you commit — that&rsquo;s the point.</span>
                    </div>
                    {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
                  </div>
                ) : (
                  <>
                    <Outcome item={item} value={response} />
                    <div className="mt-5">
                      <Button onClick={next}>{index + 1 < view.items.length ? "Next" : "Finish"}</Button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        ) : (
          <Summary view={view} />
        )}
      </div>
      <aside className="hidden lg:block">
        <div className="sticky top-24 space-y-4">
          <Stats view={view} layout="column" />
          <ScoringNote />
        </div>
      </aside>
    </div>
  );
}
