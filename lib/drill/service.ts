import { createEmptyCard, fsrs, type Card } from "ts-fsrs";
import type { QuizQuestion } from "@/lib/schema/quiz";
import { assembleSession, SESSION_SIZE } from "@/lib/drill/assemble";
import { localDate, resolveTimeZone } from "@/lib/drill/local-date";
import { toPublicQuestion, revealFor, type PublicQuestion, type Reveal } from "@/lib/drill/public";
import { completionBonus, isCorrect, pointsFor, ratingFor } from "@/lib/drill/scoring";
import { advanceStreak } from "@/lib/drill/streak";
import type { AnswerBody } from "@/lib/drill/schema";
import {
  addSessionPoints,
  calibration30d,
  completeSession,
  createSession,
  getCard,
  getSessionById,
  getSessionForDate,
  getStats,
  insertReview,
  listReviews,
  loadDrillItems,
  loadDuePool,
  loadNewPool,
  loadQuestions,
  loadReasoningPool,
  recordAnswerStats,
  recordCompletionStats,
  saveCard,
  type DrillSessionRow,
  type LearnerStatsRow,
} from "@/lib/db/drill";

// FSRS-5 defaults with a 90% retention target and a six-month cap; fuzz
// spreads a cohort's due dates so one course completion does not pile every
// card onto the same morning.
const scheduler = fsrs({ request_retention: 0.9, maximum_interval: 180, enable_fuzz: true });

export interface DrillStatsView {
  currentStreak: number;
  longestStreak: number;
  freezesAvailable: number;
  totalPoints: number;
  sessionsCompleted: number;
  accuracyPct: number | null;
  calibrationPct: number | null;
  lastCompletedLocalDate: string | null;
}

export interface AnsweredView {
  correct: boolean;
  confidence: number;
  points: number;
  response: unknown;
  reveal: Reveal;
  explanationMd?: string;
  sourceHref?: string;
}

export interface DrillItemView {
  slot: number;
  source: "retrieval" | "reasoning";
  question: PublicQuestion;
  courseTitle?: string;
  category?: string;
  answered: AnsweredView | null;
}

export interface DrillTodayView {
  empty: boolean;
  sessionId: string | null;
  localDate: string;
  timeZone: string;
  items: DrillItemView[];
  completed: boolean;
  points: number;
  correctCount: number;
  totalCount: number;
  stats: DrillStatsView;
}

function pct(num: number, den: number): number | null {
  return den > 0 ? Math.round((num / den) * 100) : null;
}

async function statsView(tenantId: string, learnerId: string): Promise<DrillStatsView> {
  const [s, cal] = await Promise.all([getStats(tenantId, learnerId), calibration30d(tenantId, learnerId)]);
  return toStatsView(s, cal.certainCorrect, cal.certainAnswered);
}

function toStatsView(s: LearnerStatsRow, certainCorrect: number, certainAnswered: number): DrillStatsView {
  return {
    currentStreak: s.currentStreak,
    longestStreak: s.longestStreak,
    freezesAvailable: s.freezesAvailable,
    totalPoints: s.totalPoints,
    sessionsCompleted: s.sessionsCompleted,
    accuracyPct: pct(s.totalCorrect, s.totalAnswered),
    calibrationPct: pct(certainCorrect, certainAnswered),
    lastCompletedLocalDate: s.lastCompletedLocalDate,
  };
}

export async function getOrCreateToday(
  tenantId: string,
  learnerId: string,
  tzRaw: string | null,
): Promise<{ session: DrillSessionRow | null; timeZone: string; localDate: string }> {
  const timeZone = resolveTimeZone(tzRaw);
  const now = new Date();
  const today = localDate(now, timeZone);
  const existing = await getSessionForDate(tenantId, learnerId, today);
  if (existing) return { session: existing, timeZone, localDate: today };

  const [dueCards, newQuestions, reasoningItems] = await Promise.all([
    loadDuePool(tenantId, learnerId, now),
    loadNewPool(tenantId, learnerId),
    loadReasoningPool(tenantId, learnerId, SESSION_SIZE),
  ]);
  const items = assembleSession({ dueCards, newQuestions, reasoningItems });
  if (items.length === 0) return { session: null, timeZone, localDate: today };
  const session = await createSession(tenantId, learnerId, today, timeZone, items);
  return { session, timeZone, localDate: today };
}

export async function emptyView(
  tenantId: string,
  learnerId: string,
  timeZone: string,
  today: string,
): Promise<DrillTodayView> {
  return {
    empty: true,
    sessionId: null,
    localDate: today,
    timeZone,
    items: [],
    completed: false,
    points: 0,
    correctCount: 0,
    totalCount: 0,
    stats: await statsView(tenantId, learnerId),
  };
}

interface Resolved {
  question: QuizQuestion;
  explanationMd?: string;
}

async function resolveQuestions(
  tenantId: string,
  learnerId: string,
  session: DrillSessionRow,
): Promise<Map<number, Resolved>> {
  const questionIds = session.items.flatMap((i) => (i.questionId ? [i.questionId] : []));
  const itemIds = session.items.flatMap((i) => (i.drillItemId ? [i.drillItemId] : []));
  const [questions, drillItems] = await Promise.all([
    loadQuestions(tenantId, learnerId, questionIds),
    loadDrillItems(tenantId, itemIds),
  ]);
  const out = new Map<number, Resolved>();
  for (const it of session.items) {
    if (it.questionId) {
      const q = questions.get(it.questionId.toLowerCase());
      if (q) out.set(it.slot, { question: q });
    } else if (it.drillItemId) {
      const d = drillItems.get(it.drillItemId.toLowerCase());
      if (d) out.set(it.slot, { question: d.payload, explanationMd: d.payload.explanationMd });
    }
  }
  return out;
}

export async function viewSession(
  tenantId: string,
  learnerId: string,
  session: DrillSessionRow,
): Promise<DrillTodayView> {
  const [resolved, reviews, stats] = await Promise.all([
    resolveQuestions(tenantId, learnerId, session),
    listReviews(tenantId, session.sessionId),
    statsView(tenantId, learnerId),
  ]);
  const bySlot = new Map(reviews.map((r) => [r.slot, r]));
  const items: DrillItemView[] = [];
  for (const it of session.items) {
    const r = resolved.get(it.slot);
    if (!r) continue;
    const rv = bySlot.get(it.slot);
    items.push({
      slot: it.slot,
      source: it.source,
      question: toPublicQuestion(r.question),
      courseTitle: it.courseTitle,
      category: it.category,
      answered: rv
        ? {
            correct: rv.correct,
            confidence: rv.confidence,
            points: rv.points,
            response: rv.response,
            reveal: revealFor(r.question),
            explanationMd: r.explanationMd,
            sourceHref: it.courseSlug ? `/learn/${it.courseSlug}` : undefined,
          }
        : null,
    });
  }
  return {
    empty: items.length === 0,
    sessionId: session.sessionId,
    localDate: session.localDate,
    timeZone: session.timeZone,
    items,
    completed: session.completedAt !== null,
    points: session.points,
    correctCount: session.correctCount,
    totalCount: items.length,
    stats,
  };
}

export type AnswerError = "not_found" | "completed" | "bad_slot" | "gone";

export async function answerSlot(
  tenantId: string,
  learnerId: string,
  body: AnswerBody,
): Promise<{ ok: true; view: DrillTodayView } | { ok: false; error: AnswerError }> {
  const session = await getSessionById(tenantId, learnerId, body.sessionId);
  if (!session) return { ok: false, error: "not_found" };
  if (session.completedAt) return { ok: false, error: "completed" };
  const item = session.items.find((i) => i.slot === body.slot);
  if (!item) return { ok: false, error: "bad_slot" };

  const resolved = await resolveQuestions(tenantId, learnerId, session);
  const target = resolved.get(item.slot);
  if (!target) return { ok: false, error: "gone" };

  const now = new Date();
  const correct = isCorrect(target.question, body.response);
  const rating = ratingFor(correct, body.confidence, body.responseMs);
  const points = pointsFor(correct, body.confidence);

  const inserted = await insertReview({
    sessionId: session.sessionId,
    tenantId,
    learnerId,
    slot: item.slot,
    cardId: item.cardId ?? null,
    questionId: item.questionId ?? null,
    drillItemId: item.drillItemId ?? null,
    response: body.response,
    correct,
    confidence: body.confidence,
    rating,
    responseMs: body.responseMs,
    points,
  });

  if (inserted) {
    if (item.questionId) {
      const existing = await getCard(tenantId, learnerId, item.questionId);
      const card: Card = existing?.card ?? createEmptyCard<Card>(now);
      const { card: next } = scheduler.next(card, now, rating);
      await saveCard(tenantId, learnerId, item.questionId, next);
    }
    await addSessionPoints(tenantId, session.sessionId, points, correct);
    await recordAnswerStats(tenantId, learnerId, correct, body.confidence, points);

    const reviews = await listReviews(tenantId, session.sessionId);
    const answered = new Set(reviews.map((r) => r.slot));
    const allDone = [...resolved.keys()].every((slot) => answered.has(slot));
    if (allDone) {
      const stats = await getStats(tenantId, learnerId);
      const streak = advanceStreak(stats, session.localDate);
      const bonus = completionBonus(streak.currentStreak);
      const marked = await completeSession(tenantId, session.sessionId, bonus);
      if (marked) await recordCompletionStats(tenantId, learnerId, streak, bonus);
    }
  }

  const fresh = await getSessionById(tenantId, learnerId, session.sessionId);
  if (!fresh) return { ok: false, error: "not_found" };
  return { ok: true, view: await viewSession(tenantId, learnerId, fresh) };
}
