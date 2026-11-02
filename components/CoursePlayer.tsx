"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { CourseDetail } from "@/lib/db/courses";
import type { MobileBlock, MobileQuestion } from "@/lib/mobile/course";
import Markdown from "@/components/Markdown";
import SlideFeedback from "@/components/SlideFeedback";
import CourseFeedback from "@/components/CourseFeedback";
import Button from "@/components/Button";
import PackageNotice from "@/components/blocks/PackageNotice";
import WrittenAnswerMark from "@/components/WrittenAnswerMark";
import {
  learnerEffects,
  type CompletionOutcome,
  type PlayerEffects,
  type QuizAnswer,
  type QuizResponse,
  type QuizResult,
} from "@/components/player-effects";
import { isImageSource, isWebUrl } from "@/lib/schema/url";
import { AI_MARKING_NOTICE, ANSWER_MAX_CHARS, verdictText, type AttemptMarks } from "@/lib/ai/grading/written-answer";

type Slide =
  | { kind: "cover"; lessonIndex: number; title: string; estMinutes: number | null }
  | { kind: "text"; lessonIndex: number; blockId: string; markdown: string }
  | { kind: "callout"; lessonIndex: number; blockId: string; variant: "info" | "warning" | "success" | "tip"; markdown: string }
  | { kind: "embed"; lessonIndex: number; blockId: string; url: string }
  | { kind: "image"; lessonIndex: number; blockId: string; url: string; alt?: string; caption?: string }
  | { kind: "quiz"; lessonIndex: number; blockId: string; quizId: string; questionIndex: number; question: MobileQuestion }
  | { kind: "package"; lessonIndex: number; blockId: string; title: string }
  | { kind: "complete"; lessonIndex: number };

// The page strips every answer key and rubric before the lessons reach the
// browser (lib/mobile/course.ts), so right or wrong only ever comes back from
// the grader in the submit response.
export type PlayerLesson = Omit<CourseDetail["lessons"][number], "blocks"> & { blocks: MobileBlock[] };
export type PlayerCourse = Pick<CourseDetail["course"], "CourseId" | "Title" | "Slug">;
export interface PlayerLink {
  href: string;
  label: string;
}

const ALL_COURSES: PlayerLink = { href: "/learn", label: "← All courses" };
const DASHBOARD: PlayerLink = { href: "/dashboard", label: "← Back to dashboard" };

function flattenLessons(lessons: PlayerLesson[]): Slide[] {
  const slides: Slide[] = [];
  lessons.forEach((lesson, lessonIndex) => {
    slides.push({
      kind: "cover",
      lessonIndex,
      title: lesson.Title,
      estMinutes: lesson.EstMinutes,
    });
    lesson.blocks.forEach((block) => {
      switch (block.kind) {
        case "text":
          slides.push({ kind: "text", lessonIndex, blockId: block.blockId, markdown: block.markdown });
          break;
        case "callout":
          slides.push({
            kind: "callout",
            lessonIndex,
            blockId: block.blockId,
            variant: block.variant,
            markdown: block.markdown,
          });
          break;
        case "embed":
        case "video":
          slides.push({ kind: "embed", lessonIndex, blockId: block.blockId, url: block.url });
          break;
        case "image":
          slides.push({
            kind: "image",
            lessonIndex,
            blockId: block.blockId,
            url: block.url,
            alt: block.alt,
            caption: block.caption,
          });
          break;
        case "quiz":
          block.questions.forEach((question, questionIndex) => {
            slides.push({
              kind: "quiz",
              lessonIndex,
              blockId: block.blockId,
              quizId: block.quizId,
              questionIndex,
              question,
            });
          });
          break;
        case "package":
          slides.push({ kind: "package", lessonIndex, blockId: block.blockId, title: block.title });
          break;
      }
    });
  });
  slides.push({ kind: "complete", lessonIndex: Math.max(0, lessons.length - 1) });
  return slides;
}

function youtubeEmbedUrl(url: string): string | null {
  if (!isWebUrl(url)) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return `https://www.youtube.com/embed/${u.pathname.slice(1)}`;
    if (host === "youtube.com" || host === "m.youtube.com") {
      if (u.pathname === "/watch") {
        const v = u.searchParams.get("v");
        return v ? `https://www.youtube.com/embed/${v}` : null;
      }
      if (u.pathname.startsWith("/live/")) return `https://www.youtube.com/embed/${u.pathname.split("/")[2]}`;
      if (u.pathname.startsWith("/embed/")) return url;
    }
    return null;
  } catch {
    return null;
  }
}

// Minimum seconds a learner must dwell on a slide the first time they see it
// before the Next button unlocks. Polite floor on click-through-without-reading,
// not anti-cheat — re-visits and slides without a block (cover, complete) skip it.
const MIN_INITIAL_DWELL_SECONDS = 5;

// After a quiz with written answers is submitted where AI marking is on, the
// player reads the attempt's marks this many milliseconds apart until each
// written answer has one; the learner can also check by hand.
const MARK_POLL_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 45_000];

// What one quiz slide is told about its quiz's written-answer marks.
interface QuizMarks {
  marks?: AttemptMarks;
  marking: boolean;
  checking: boolean;
  onCheck?: () => void;
  onAskForReview?: (questionId: string, note: string | null) => Promise<void>;
}

export default function CoursePlayer({
  course,
  lessons,
  completedBlockIds = [],
  effects: injectedEffects,
  exitLink,
  aiMarking = false,
}: {
  course: PlayerCourse;
  lessons: PlayerLesson[];
  completedBlockIds?: string[];
  // Everything the player writes. Omitted, it is the learner's own; the author
  // preview passes effects that write nothing.
  effects?: PlayerEffects;
  // Where the header and the last slide lead out; omitted, the learner's pages.
  exitLink?: PlayerLink;
  // The tenant has AI marking of written answers on (lib/ai/grading/policy.ts):
  // the player says so on each written question and waits for the AI's mark.
  aiMarking?: boolean;
}) {
  const effects = useMemo(
    () => injectedEffects ?? learnerEffects(course.CourseId),
    [injectedEffects, course.CourseId],
  );
  const slides = useMemo(() => flattenLessons(lessons), [lessons]);

  // First video slide per lesson, if any. Drives the optional "Watch this
  // lesson as a video" button on each lesson's cover slide — present only when
  // that lesson actually carries a video/embed block.
  const videoSlideIndexByLesson = useMemo(() => {
    const map = new Map<number, number>();
    slides.forEach((s, i) => {
      if (s.kind === "embed" && !map.has(s.lessonIndex)) map.set(s.lessonIndex, i);
    });
    return map;
  }, [slides]);

  // M4 scoring. The player shows quiz questions one slide at a time, but a
  // score is per-quiz — so we collect each quiz's answers (positional, by
  // question index) and hand the whole quiz to effects.submitQuiz once every
  // question is answered. The server grades against the answer key (for a
  // learner it also persists a QuizAttempt); we keep the in-flight promise so the completion
  // slide can wait for all submissions to land before checking the pass gate.
  const quizQuestionCounts = useMemo(() => {
    const map = new Map<string, number>();
    lessons.forEach((l) =>
      l.blocks.forEach((b) => {
        if (b.kind === "quiz") map.set(b.quizId, b.questions.length);
      }),
    );
    return map;
  }, [lessons]);

  const firstQuizSlideIndex = useMemo(
    () => slides.findIndex((s) => s.kind === "quiz"),
    [slides],
  );

  const quizResponses = useRef<Map<string, QuizResponse[]>>(new Map());
  const submittedQuizzes = useRef<Set<string>>(new Set());
  const inFlightSubmits = useRef<Array<Promise<unknown>>>([]);
  const [quizResults, setQuizResults] = useState<Record<string, QuizResult>>({});

  // Written answers are marked after the submit, by AI where the tenant has it
  // on and by an instructor in any case, so their marks are read separately.
  const writtenQuizIds = useMemo(() => {
    const ids = new Set<string>();
    lessons.forEach((l) =>
      l.blocks.forEach((b) => {
        if (b.kind === "quiz" && b.questions.some((q) => q.kind === "short")) ids.add(b.quizId);
      }),
    );
    return ids;
  }, [lessons]);
  const [quizMarks, setQuizMarks] = useState<Record<string, AttemptMarks>>({});
  const [markPolls, setMarkPolls] = useState<Record<string, boolean>>({});
  const [markChecks, setMarkChecks] = useState<Record<string, boolean>>({});
  const pollTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    const timers = pollTimers.current;
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  const readMarks = useCallback(
    async (quizId: string, attemptId: string): Promise<AttemptMarks | null> => {
      if (!effects.readAttempt) return null;
      try {
        const marks = await effects.readAttempt(attemptId);
        setQuizMarks((m) => ({ ...m, [quizId]: marks }));
        return marks;
      } catch {
        return null;
      }
    },
    [effects],
  );

  const pollMarks = useCallback(
    (quizId: string, attemptId: string, round = 0) => {
      const delay = MARK_POLL_DELAYS_MS[round];
      if (delay === undefined) {
        setMarkPolls((m) => ({ ...m, [quizId]: false }));
        return;
      }
      setMarkPolls((m) => ({ ...m, [quizId]: true }));
      const timer = setTimeout(() => {
        pollTimers.current.delete(timer);
        void readMarks(quizId, attemptId).then((marks) => {
          if (marks && !marks.written.some((w) => w.status === "awaiting_instructor")) {
            setMarkPolls((m) => ({ ...m, [quizId]: false }));
          } else {
            pollMarks(quizId, attemptId, round + 1);
          }
        });
      }, delay);
      pollTimers.current.add(timer);
    },
    [readMarks],
  );

  const checkMarks = useCallback(
    (quizId: string, attemptId: string) => {
      setMarkChecks((m) => ({ ...m, [quizId]: true }));
      void readMarks(quizId, attemptId).finally(() => setMarkChecks((m) => ({ ...m, [quizId]: false })));
    },
    [readMarks],
  );

  const askForReview = useCallback(
    async (quizId: string, attemptId: string, questionId: string, note: string | null) => {
      if (!effects.requestReview) return;
      await effects.requestReview({ attemptId, questionId, note });
      await readMarks(quizId, attemptId);
    },
    [effects, readMarks],
  );

  const marksFor = (quizId: string): QuizMarks => {
    const shown = { marks: quizMarks[quizId], marking: markPolls[quizId] === true, checking: markChecks[quizId] === true };
    const attemptId = quizResults[quizId]?.attemptId;
    if (!attemptId || !writtenQuizIds.has(quizId) || !effects.readAttempt) return shown;
    return {
      ...shown,
      onCheck: () => checkMarks(quizId, attemptId),
      onAskForReview: effects.requestReview ? (questionId, note) => askForReview(quizId, attemptId, questionId, note) : undefined,
    };
  };

  const recordQuizAnswer = useCallback(
    (quizId: string, questionIndex: number, value: QuizAnswer) => {
      const count = quizQuestionCounts.get(quizId) ?? 0;
      if (count === 0) return;
      const arr = quizResponses.current.get(quizId) ?? new Array<QuizResponse>(count).fill(null);
      arr[questionIndex] = value;
      quizResponses.current.set(quizId, arr);
      if (arr.some((a) => a === null) || submittedQuizzes.current.has(quizId)) return;
      submittedQuizzes.current.add(quizId);
      const p = effects
        .submitQuiz(quizId, [...arr])
        .then((data: QuizResult) => {
          setQuizResults((m) => ({
            ...m,
            [quizId]: {
              attemptId: data.attemptId,
              score: data.score,
              passed: data.passed,
              passingScore: data.passingScore,
              correctCount: data.correctCount,
              autoGradableCount: data.autoGradableCount,
              perQuestion: data.perQuestion,
            },
          }));
          if (data.attemptId && writtenQuizIds.has(quizId) && effects.readAttempt) {
            if (aiMarking) pollMarks(quizId, data.attemptId);
            else void readMarks(quizId, data.attemptId);
          }
        })
        .catch(() => {
          // Allow a retry on the next answer change if the submit failed.
          submittedQuizzes.current.delete(quizId);
        });
      inFlightSubmits.current.push(p);
    },
    [quizQuestionCounts, effects, writtenQuizIds, aiMarking, pollMarks, readMarks],
  );

  // Resolves once every quiz submission fired so far has settled (persisted or
  // failed). The completion slide awaits this before checking the pass gate so a
  // just-answered final quiz can't lose a race with the completion POST.
  const awaitQuizSubmits = useCallback(
    () => Promise.allSettled(inFlightSubmits.current).then(() => undefined),
    [],
  );

  // Lets a question slide show the answer already given when the learner
  // comes back to it, instead of offering a second answer the grader won't see.
  const recordedAnswer = useCallback(
    (quizId: string, questionIndex: number): QuizResponse => quizResponses.current.get(quizId)?.[questionIndex] ?? null,
    [],
  );

  const retryQuizzes = useCallback(() => {
    quizResponses.current.clear();
    submittedQuizzes.current.clear();
    inFlightSubmits.current = [];
    setQuizResults({});
    pollTimers.current.forEach((t) => clearTimeout(t));
    pollTimers.current.clear();
    setQuizMarks({});
    setMarkPolls({});
    if (firstQuizSlideIndex >= 0) setIndex(firstQuizSlideIndex);
  }, [firstQuizSlideIndex]);

  // Blocks this learner has already viewed — seeded from the server-side
  // Progress table on mount, then grown locally as the beacon fires. Drives
  // both resume (where to land) and the dwell-gate skip (no double-gating).
  const seenBlockIds = useRef<Set<string>>(new Set(completedBlockIds));

  // Resume: jump to the first content slide whose block hasn't been seen yet.
  // Cover/complete slides have no blockId so they don't count — we always land
  // directly on the first unread content block. Fully-seen courses fall back
  // to slide 0 for review.
  const initialIndex = useMemo(() => {
    const idx = slides.findIndex(
      (s) => "blockId" in s && !seenBlockIds.current.has(s.blockId),
    );
    return idx >= 0 ? idx : 0;
  }, [slides]);

  const [index, setIndex] = useState(initialIndex);
  const slide = slides[index];

  // Dwell gate. On first view of a slide whose block isn't yet seen, hold Next
  // for MIN_INITIAL_DWELL_SECONDS so a learner can't strafe through unread
  // content. Re-visits (already in seenBlockIds) and cover/complete slides
  // (no blockId) skip the gate entirely.
  const [dwellRemaining, setDwellRemaining] = useState(0);
  useEffect(() => {
    // Image slides are decorative lesson illustrations — nothing to read, so
    // holding the learner on them is pure friction (learner feedback 2026-08).
    // A package slide is done by its activity, not by dwelling on it.
    if (
      !slide ||
      !("blockId" in slide) ||
      slide.kind === "image" ||
      slide.kind === "package" ||
      seenBlockIds.current.has(slide.blockId)
    ) {
      setDwellRemaining(0);
      return;
    }
    setDwellRemaining(MIN_INITIAL_DWELL_SECONDS);
    const start = Date.now();
    const interval = setInterval(() => {
      const remaining = Math.max(
        0,
        MIN_INITIAL_DWELL_SECONDS - (Date.now() - start) / 1000,
      );
      setDwellRemaining(remaining);
      if (remaining <= 0) clearInterval(interval);
    }, 200);
    return () => clearInterval(interval);
  }, [slide]);

  const canAdvance = dwellRemaining <= 0 && index < slides.length - 1;

  // Both the button and the keyboard handler call next(); the gate lives here
  // so neither path bypasses it.
  const next = useCallback(() => {
    if (dwellRemaining > 0) return;
    setIndex((i) => Math.min(slides.length - 1, i + 1));
  }, [slides.length, dwellRemaining]);
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev]);

  // Progress beacon: the first time a learner lands on a content slide, record
  // that block as seen. A Set guards against re-posting when they scrub back
  // and forth — the completion endpoint is the source of truth either way.
  // The server refuses a package block's beacon: its activity records it.
  const beaconedBlocks = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!slide || !("blockId" in slide) || slide.kind === "package") return;
    const { blockId } = slide;
    if (beaconedBlocks.current.has(blockId)) return;
    beaconedBlocks.current.add(blockId);
    seenBlockIds.current.add(blockId);
    effects.recordSeen(blockId).catch(() => beaconedBlocks.current.delete(blockId));
  }, [slide, effects]);

  if (lessons.length === 0 || !slide) {
    return (
      <div className="text-sm text-gray-500">This course has no content yet.</div>
    );
  }

  const lesson = lessons[slide.lessonIndex];
  const progressPct = Math.round(((index + 1) / slides.length) * 100);
  const coverVideoSlideIndex =
    slide.kind === "cover" ? videoSlideIndexByLesson.get(slide.lessonIndex) : undefined;

  return (
    <div className="flex flex-col min-h-[calc(100vh-180px)]">
      <header className="mb-6">
        <Link
          href={(exitLink ?? ALL_COURSES).href}
          prefetch={false}
          className="text-xs font-semibold hover:underline"
          style={{ color: "var(--brand-primary)" }}
        >
          {(exitLink ?? ALL_COURSES).label}
        </Link>
        <div className="mt-3 flex items-baseline justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-500">
              Lesson {slide.lessonIndex + 1} of {lessons.length}
              {lesson?.EstMinutes ? ` · ~${lesson.EstMinutes} min` : ""}
            </p>
            <h2
              className="text-lg font-semibold"
              style={{ color: "var(--brand-primary)" }}
            >
              {lesson?.Title ?? course.Title}
            </h2>
          </div>
          <p className="text-xs text-gray-500 whitespace-nowrap">
            Slide {index + 1} / {slides.length}
          </p>
        </div>
        <div className="mt-3 h-1 w-full bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full transition-all"
            style={{ width: `${progressPct}%`, backgroundColor: "var(--brand-primary)" }}
          />
        </div>
      </header>

      <main className="flex-1 flex items-stretch">
        <div className="w-full bg-white rounded-lg border border-gray-200 shadow-sm p-8 md:p-12">
          <SlideBody
            slide={slide}
            courseTitle={course.Title}
            courseSlug={course.Slug}
            complete={effects.complete}
            feedback={effects.feedback}
            exitLink={exitLink ?? DASHBOARD}
            onWatchVideo={
              coverVideoSlideIndex !== undefined
                ? () => setIndex(coverVideoSlideIndex)
                : undefined
            }
            onQuizAnswer={recordQuizAnswer}
            recordedAnswer={recordedAnswer}
            onRetryQuiz={retryQuizzes}
            awaitQuizSubmits={awaitQuizSubmits}
            quizResults={quizResults}
            aiMarking={aiMarking}
            marksFor={marksFor}
          />
        </div>
      </main>

      {effects.feedback && "blockId" in slide ? (
        <div className="mt-4">
          <SlideFeedback
            courseSlug={course.Slug}
            blockId={slide.blockId}
            lessonNumber={slide.lessonIndex + 1}
            lessonTitle={lesson?.Title ?? course.Title}
            slideNumber={index + 1}
            totalSlides={slides.length}
          />
        </div>
      ) : null}

      <nav className="mt-6 flex items-center justify-between">
        <Button
          type="button"
          variant="outline"
          onClick={prev}
          disabled={index === 0}
        >
          ← Previous
        </Button>
        <p className="text-xs text-gray-400 hidden sm:block">Use ← / → keys to navigate</p>
        <Button
          type="button"
          variant="primary"
          onClick={next}
          disabled={!canAdvance}
        >
          {slide.kind === "complete"
            ? "Finished"
            : dwellRemaining > 0
              ? `Next → (${Math.ceil(dwellRemaining)}s)`
              : "Next →"}
        </Button>
      </nav>
    </div>
  );
}

function SlideBody({
  slide,
  courseTitle,
  courseSlug,
  complete,
  feedback,
  exitLink,
  onWatchVideo,
  onQuizAnswer,
  recordedAnswer,
  onRetryQuiz,
  awaitQuizSubmits,
  quizResults,
  aiMarking = false,
  marksFor,
}: {
  slide: Slide;
  courseTitle: string;
  courseSlug: string;
  complete: PlayerEffects["complete"];
  feedback: boolean;
  exitLink: PlayerLink;
  onWatchVideo?: () => void;
  onQuizAnswer?: (quizId: string, questionIndex: number, value: QuizAnswer) => void;
  recordedAnswer?: (quizId: string, questionIndex: number) => QuizResponse;
  onRetryQuiz?: () => void;
  awaitQuizSubmits?: () => Promise<void>;
  quizResults?: Record<string, QuizResult>;
  aiMarking?: boolean;
  marksFor?: (quizId: string) => QuizMarks;
}) {
  switch (slide.kind) {
    case "cover":
      return (
        <div className="flex flex-col items-center justify-center text-center min-h-[300px]">
          <p className="text-xs uppercase tracking-widest text-gray-500 mb-3">Lesson {slide.lessonIndex + 1}</p>
          <h1 className="text-3xl md:text-4xl font-bold text-gray-900 max-w-2xl">{slide.title}</h1>
          {slide.estMinutes ? (
            <p className="mt-4 text-sm text-gray-500">~{slide.estMinutes} minutes</p>
          ) : null}
          {onWatchVideo ? (
            <div className="mt-8 flex flex-col items-center gap-2">
              <Button type="button" variant="primary" onClick={onWatchVideo}>
                ▶ Watch this lesson as a video
              </Button>
              <p className="text-xs text-gray-400">or press → to read the lesson</p>
            </div>
          ) : (
            <p className="mt-8 text-sm text-gray-400">Press → to begin</p>
          )}
        </div>
      );
    case "text":
      return <Markdown>{slide.markdown}</Markdown>;
    case "callout": {
      const palette: Record<typeof slide.variant, string> = {
        info: "bg-blue-50 border-blue-200 text-blue-900",
        warning: "bg-amber-50 border-amber-200 text-amber-900",
        success: "bg-emerald-50 border-emerald-200 text-emerald-900",
        tip: "bg-violet-50 border-violet-200 text-violet-900",
      };
      const labels: Record<typeof slide.variant, string> = {
        info: "Info",
        warning: "Warning",
        success: "Key insight",
        tip: "Pro tip",
      };
      return (
        <div className={`border-l-4 rounded-md p-6 ${palette[slide.variant]}`}>
          <p className="text-xs uppercase tracking-wider font-semibold mb-3 opacity-70">
            {labels[slide.variant]}
          </p>
          <Markdown className="prose prose-sm max-w-none prose-headings:text-current prose-strong:text-current">
            {slide.markdown}
          </Markdown>
        </div>
      );
    }
    case "embed": {
      const src = youtubeEmbedUrl(slide.url);
      if (!src) {
        if (!isWebUrl(slide.url)) return <p className="text-sm text-gray-500">This video isn&apos;t available.</p>;
        return (
          <a
            href={slide.url}
            className="text-sm font-semibold underline"
            style={{ color: "var(--brand-primary)" }}
            target="_blank"
            rel="noreferrer"
          >
            Open video ↗
          </a>
        );
      }
      return (
        <div className="aspect-video w-full overflow-hidden rounded-md bg-black">
          <iframe
            src={src}
            title={`Video for ${courseTitle}`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="w-full h-full border-0"
          />
        </div>
      );
    }
    case "image":
      if (!isImageSource(slide.url)) return null;
      return (
        <figure>
          <img src={slide.url} alt={slide.alt ?? ""} className="w-full rounded-md" />
          {slide.caption ? (
            <figcaption className="text-xs text-gray-500 mt-3 text-center">{slide.caption}</figcaption>
          ) : null}
        </figure>
      );
    case "quiz":
      return (
        <QuizSlide
          key={`${slide.blockId}:${slide.questionIndex}`}
          question={slide.question}
          questionIndex={slide.questionIndex}
          recorded={recordedAnswer?.(slide.quizId, slide.questionIndex) ?? null}
          result={quizResults?.[slide.quizId]}
          aiMarking={aiMarking}
          written={marksFor?.(slide.quizId)}
          onAnswered={
            onQuizAnswer
              ? (value) => onQuizAnswer(slide.quizId, slide.questionIndex, value)
              : undefined
          }
        />
      );
    case "package":
      return <PackageNotice title={slide.title} />;
    case "complete":
      return (
        <CompleteSlide
          courseTitle={courseTitle}
          courseSlug={courseSlug}
          complete={complete}
          feedback={feedback}
          exitLink={exitLink}
          onRetryQuiz={onRetryQuiz}
          awaitQuizSubmits={awaitQuizSubmits}
          quizResults={quizResults}
        />
      );
  }
}

// The final slide records completion and surfaces the certificate. For a
// learner, complete() records completion on mount (player-effects.ts); that is
// idempotent, so a learner re-reaching this slide gets their existing
// certificate back.
function CompleteSlide({
  courseTitle,
  courseSlug,
  complete,
  feedback,
  exitLink,
  onRetryQuiz,
  awaitQuizSubmits,
  quizResults,
}: {
  courseTitle: string;
  courseSlug: string;
  complete: PlayerEffects["complete"];
  feedback: boolean;
  exitLink: PlayerLink;
  onRetryQuiz?: () => void;
  awaitQuizSubmits?: () => Promise<void>;
  quizResults?: Record<string, QuizResult>;
}) {
  const [state, setState] = useState<
    | { status: "saving" }
    | ({ status: "done" } & CompletionOutcome)
    | { status: "error" }
  >({ status: "saving" });

  useEffect(() => {
    let cancelled = false;
    // Wait for any in-flight quiz submissions to persist first, so a just-graded
    // final quiz is visible to the server-side pass gate when we POST complete.
    Promise.resolve(awaitQuizSubmits?.())
      .then(() => complete())
      .then((outcome) => {
        if (cancelled) return;
        setState({ status: "done", ...outcome });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [complete, awaitQuizSubmits]);

  const gateBlocked =
    state.status === "done" && state.quizGate?.required === true && state.quizGate.passed === false;

  // For the gate message, surface the first not-yet-passed quiz: its threshold
  // and the learner's best score (preferring the score just returned by the
  // submit endpoint, falling back to the server gate's stored best).
  const failingQuiz =
    state.status === "done" ? state.quizGate?.quizzes.find((q) => !q.passed) ?? null : null;
  const localBest = quizResults
    ? Object.values(quizResults).filter((r) => !r.passed).sort((a, b) => b.score - a.score)[0] ?? null
    : null;
  const shownScore = localBest?.score ?? failingQuiz?.bestScore ?? null;
  const shownThreshold = localBest?.passingScore ?? failingQuiz?.passingScore ?? null;

  return (
    <div className="flex flex-col items-center justify-center text-center min-h-[300px]">
      <div className="text-5xl mb-4">{gateBlocked ? "📋" : "🎉"}</div>
      <h1 className="text-2xl md:text-3xl font-bold text-gray-900">
        {gateBlocked ? "Almost there" : "Course complete"}
      </h1>
      <p className="mt-3 text-gray-600 max-w-prose">
        {gateBlocked ? (
          <>
            You&rsquo;ve read every lesson in{" "}
            <span className="font-semibold">{courseTitle}</span> — one step left:
            pass the knowledge check.
          </>
        ) : (
          <>
            You&rsquo;ve made it through every lesson in{" "}
            <span className="font-semibold">{courseTitle}</span>.
          </>
        )}
      </p>

      {state.status === "saving" ? (
        <p className="mt-6 text-sm text-gray-400">Saving your progress…</p>
      ) : null}

      {state.status === "error" ? (
        <p className="mt-6 text-sm text-rose-600">
          We couldn&rsquo;t save your completion. Reload this slide to try again.
        </p>
      ) : null}

      {gateBlocked ? (
        <div className="mt-6 w-full max-w-md rounded-md border border-amber-200 bg-amber-50 p-4 text-amber-900">
          <p className="font-semibold">Knowledge check not passed yet</p>
          {shownScore !== null && shownThreshold !== null ? (
            <p className="mt-1 text-sm">
              You scored <span className="font-semibold">{shownScore}%</span>. You need{" "}
              <span className="font-semibold">{shownThreshold}%</span> to finish and earn
              your certificate.
            </p>
          ) : (
            <p className="mt-1 text-sm">
              Review the lessons and take the knowledge check again to finish.
            </p>
          )}
          {onRetryQuiz ? (
            <Button type="button" variant="primary" onClick={onRetryQuiz} className="mt-3">
              Retake the knowledge check
            </Button>
          ) : null}
        </div>
      ) : null}

      {state.status === "done" && !gateBlocked && state.serialNo ? (
        <>
          <p className="mt-6 text-sm text-emerald-700 font-semibold">
            Your certificate of completion is ready.
          </p>
          <Button
            href={`/certificate/${state.serialNo}`}
            variant="primary"
            prefetch={false}
            target="_blank"
            className="mt-3"
          >
            View &amp; download certificate ↗
          </Button>
        </>
      ) : null}

      {feedback ? (
        <div className="w-full max-w-lg text-left">
          <CourseFeedback courseSlug={courseSlug} courseTitle={courseTitle} />
        </div>
      ) : null}

      <Link
        href={exitLink.href}
        prefetch={false}
        className="mt-8 text-sm font-semibold hover:underline"
        style={{ color: "var(--brand-primary)" }}
      >
        {exitLink.label}
      </Link>
    </div>
  );
}

function QuizSlide({
  question,
  questionIndex,
  recorded,
  result,
  aiMarking = false,
  written,
  onAnswered,
}: {
  question: MobileQuestion;
  questionIndex: number;
  recorded: QuizResponse;
  result?: QuizResult;
  aiMarking?: boolean;
  written?: QuizMarks;
  onAnswered?: (value: QuizAnswer) => void;
}) {
  const [picked, setPicked] = useState<QuizResponse>(recorded);
  const [submitted, setSubmitted] = useState(recorded !== null);

  function pick(value: string | boolean) {
    if (submitted) return;
    setPicked(value);
  }

  function toggle(id: string) {
    if (submitted) return;
    const current = Array.isArray(picked) ? picked : [];
    const next = current.includes(id) ? current.filter((c) => c !== id) : [...current, id];
    setPicked(next.length > 0 ? next : null);
  }

  const writtenText = typeof picked === "string" ? picked : "";
  const canSubmit = question.kind === "short" ? writtenText.trim().length > 0 : picked !== null;

  function submit() {
    // A written answer goes as typed; the grader skips it and it is marked
    // after the submit (by AI where the tenant has it on, else an instructor).
    if (!canSubmit || picked === null) return;
    setSubmitted(true);
    onAnswered?.(picked);
  }

  const correct = submitted
    ? result?.perQuestion.find((p) => p.orderIndex === questionIndex)?.correct ?? null
    : null;
  const graded = submitted && result !== undefined;
  const marks = written?.marks;
  const mark = marks?.written.find((w) => w.orderIndex === questionIndex);
  const askForReview = written?.onAskForReview;

  const choiceClass = (isPicked: boolean) =>
    isPicked && graded && correct === true
      ? "bg-emerald-50 border-emerald-300 text-emerald-900"
      : isPicked && graded && correct === false
        ? "bg-rose-50 border-rose-300 text-rose-900"
        : isPicked
          ? "bg-blue-50 border-blue-300 text-blue-900"
          : "bg-white border-gray-200 hover:border-gray-400";

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs uppercase tracking-widest text-gray-500 mb-2">
          Knowledge check · Question {questionIndex + 1}
        </p>
        <div className="text-lg font-medium text-gray-900">
          <Markdown className="prose prose-slate max-w-none">{question.promptMd}</Markdown>
        </div>
      </div>

      {question.kind === "mcq" || question.kind === "confidence" ? (
        <div className="space-y-2">
          {question.choices.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => pick(c.id)}
              disabled={submitted}
              className={`w-full text-left px-4 py-3 rounded-md border transition-colors ${choiceClass(picked === c.id)}`}
            >
              <span className="font-mono text-xs mr-3 text-gray-500">{c.id.toUpperCase()}</span>
              {c.label}
            </button>
          ))}
        </div>
      ) : null}

      {question.kind === "multi" ? (
        <div className="space-y-2">
          <p className="text-sm text-gray-500">Select all that apply.</p>
          {question.choices.map((c) => {
            const isPicked = Array.isArray(picked) && picked.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                role="checkbox"
                aria-checked={isPicked}
                onClick={() => toggle(c.id)}
                disabled={submitted}
                className={`w-full text-left px-4 py-3 rounded-md border transition-colors ${choiceClass(isPicked)}`}
              >
                <span className="font-mono text-xs mr-3 text-gray-500">{isPicked ? "☑" : "☐"}</span>
                {c.label}
              </button>
            );
          })}
        </div>
      ) : null}

      {question.kind === "tf" ? (
        <div className="flex gap-3">
          {[true, false].map((v) => (
            <button
              key={String(v)}
              type="button"
              onClick={() => pick(v)}
              disabled={submitted}
              className={`flex-1 px-4 py-3 rounded-md border font-medium transition-colors ${choiceClass(picked === v)}`}
            >
              {v ? "True" : "False"}
            </button>
          ))}
        </div>
      ) : null}

      {question.kind === "short" ? (
        <div className="space-y-2">
          <label className="block text-sm text-gray-600">
            Your answer
            <textarea
              value={writtenText}
              onChange={(e) => {
                if (!submitted) setPicked(e.target.value === "" ? null : e.target.value);
              }}
              readOnly={submitted}
              maxLength={ANSWER_MAX_CHARS}
              rows={6}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white p-3 text-base text-gray-900"
            />
          </label>
          <p className="text-xs text-gray-500">
            {aiMarking ? AI_MARKING_NOTICE : "Your instructor marks written answers."}
          </p>
        </div>
      ) : null}

      {!submitted ? (
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="px-5 py-2 text-sm font-semibold rounded-md text-white disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ backgroundColor: "var(--brand-primary)" }}
        >
          Submit answer
        </button>
      ) : (
        <div
          className={`rounded-md p-4 text-sm ${
            correct === true
              ? "bg-emerald-50 border border-emerald-200 text-emerald-900"
              : correct === false
                ? "bg-rose-50 border border-rose-200 text-rose-900"
                : "bg-violet-50 border border-violet-200 text-violet-900"
          }`}
        >
          {correct === true ? <p className="font-semibold">✓ Correct.</p> : null}
          {correct === false ? <p className="font-semibold">✗ Not quite.</p> : null}
          {!graded ? <p>Answer recorded. Your result shows once every question in this check is answered.</p> : null}
          {graded && question.kind === "short" && mark ? (
            <WrittenAnswerMark
              mark={mark}
              marking={written?.marking === true}
              onAskForReview={askForReview ? (note) => askForReview(mark.questionId, note) : undefined}
            />
          ) : null}
          {graded && question.kind === "short" && !mark ? (
            <p>{written?.marking ? "Marking your answer…" : "Answer recorded. Your instructor will mark it."}</p>
          ) : null}
          {graded && marks ? (
            <p className="mt-2">{verdictText(marks)}</p>
          ) : graded && result && result.autoGradableCount > 0 ? (
            <p className="mt-2">
              Knowledge check score: {result.score}% ({result.correctCount} of {result.autoGradableCount} correct).{" "}
              {result.passed ? "Passed." : `The pass mark is ${result.passingScore}%.`}
            </p>
          ) : null}
          {graded && question.kind === "short" && written?.onCheck ? (
            <button
              type="button"
              onClick={written.onCheck}
              disabled={written.checking}
              className="mt-2 text-sm font-semibold underline disabled:opacity-40"
            >
              {written.checking ? "Checking…" : "Check for new marks"}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
