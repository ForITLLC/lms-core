import { randomUUID } from "node:crypto";
import type { Card } from "ts-fsrs";
import { execute, query, queryOne } from "@/lib/db";
import { lastCompletedAt } from "@/lib/db/completion";
import { learnerAccessibleScope } from "@/lib/db/course-scope";
import { QuizQuestion } from "@/lib/schema/quiz";
import type { DuePool, NewPool, ReasoningPool, SessionItem } from "@/lib/drill/assemble";
import { RETRIEVAL_SLOTS } from "@/lib/drill/assemble";
import type { StreakStats, StreakResult } from "@/lib/drill/streak";
import { ReasoningPayload } from "@/lib/drill/schema";

// Every query here is tenant-scoped. Retrieval questions come only from
// courses in the learner's catalogue (own tenant or subscribed), and only
// from enrollments the learner has completed. Reasoning items come only from
// the tenant's own bank.

const RETRIEVAL_KINDS = "('mcq', 'tf', 'multi', 'confidence')";

function isUniqueViolation(err: unknown): boolean {
  const e = err as { number?: number; message?: string };
  return e?.number === 2627 || e?.number === 2601 || /UNIQUE KEY|duplicate key/i.test(e?.message ?? "");
}

export interface DrillSessionRow {
  sessionId: string;
  localDate: string;
  timeZone: string;
  items: SessionItem[];
  startedAt: Date;
  completedAt: Date | null;
  points: number;
  correctCount: number;
  totalCount: number;
}

interface SessionDb {
  SessionId: string;
  LocalDate: Date | string;
  TimeZone: string;
  ItemsJson: string;
  StartedAt: Date;
  CompletedAt: Date | null;
  Points: number;
  CorrectCount: number;
  TotalCount: number;
}

function toLocalDateString(v: Date | string): string {
  if (typeof v === "string") return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
}

function mapSession(r: SessionDb): DrillSessionRow {
  return {
    sessionId: r.SessionId,
    localDate: toLocalDateString(r.LocalDate),
    timeZone: r.TimeZone,
    items: JSON.parse(r.ItemsJson) as SessionItem[],
    startedAt: r.StartedAt,
    completedAt: r.CompletedAt,
    points: r.Points,
    correctCount: r.CorrectCount,
    totalCount: r.TotalCount,
  };
}

const SESSION_SELECT = `SELECT CONVERT(varchar(64), SessionId) AS SessionId,
            CONVERT(varchar(10), LocalDate, 23) AS LocalDate,
            TimeZone, ItemsJson, StartedAt, CompletedAt, Points, CorrectCount, TotalCount
       FROM lms.DrillSession`;

export async function getSessionForDate(
  tenantId: string,
  learnerId: string,
  localDate: string,
): Promise<DrillSessionRow | null> {
  const row = await queryOne<SessionDb>(
    `${SESSION_SELECT}
      WHERE TenantId = @tenantId AND LearnerId = @learnerId AND LocalDate = @localDate`,
    { tenantId, learnerId, localDate },
  );
  return row ? mapSession(row) : null;
}

export async function getSessionById(
  tenantId: string,
  learnerId: string,
  sessionId: string,
): Promise<DrillSessionRow | null> {
  const row = await queryOne<SessionDb>(
    `${SESSION_SELECT}
      WHERE TenantId = @tenantId AND LearnerId = @learnerId AND SessionId = @sessionId`,
    { tenantId, learnerId, sessionId },
  );
  return row ? mapSession(row) : null;
}

export async function createSession(
  tenantId: string,
  learnerId: string,
  localDate: string,
  timeZone: string,
  items: SessionItem[],
): Promise<DrillSessionRow> {
  const sessionId = randomUUID();
  try {
    await execute(
      `INSERT INTO lms.DrillSession
         (SessionId, TenantId, LearnerId, LocalDate, TimeZone, ItemsJson, TotalCount)
       VALUES (@sessionId, @tenantId, @learnerId, @localDate, @timeZone, @itemsJson, @totalCount)`,
      {
        sessionId,
        tenantId,
        learnerId,
        localDate,
        timeZone,
        itemsJson: JSON.stringify(items),
        totalCount: items.length,
      },
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  const row = await getSessionForDate(tenantId, learnerId, localDate);
  if (!row) throw new Error("DrillSession insert failed");
  return row;
}

export async function loadDuePool(
  tenantId: string,
  learnerId: string,
  now: Date,
  limit = RETRIEVAL_SLOTS,
): Promise<DuePool[]> {
  const rows = await query<{
    CardId: string;
    QuestionId: string;
    CourseId: string;
    Title: string;
    Slug: string;
    Due: Date;
  }>(
    `SELECT TOP (@limit)
            CONVERT(varchar(64), dc.CardId)     AS CardId,
            CONVERT(varchar(64), dc.QuestionId) AS QuestionId,
            CONVERT(varchar(64), c.CourseId)    AS CourseId,
            c.Title, c.Slug, dc.Due
       FROM lms.DrillCard dc
       JOIN lms.QuizQuestion qq ON qq.QuestionId = dc.QuestionId
       JOIN lms.Quiz q   ON q.QuizId   = qq.QuizId
       JOIN lms.Block b  ON b.BlockId  = q.BlockId
       JOIN lms.Lesson l ON l.LessonId = b.LessonId
       JOIN lms.Course c ON c.CourseId = l.CourseId
      WHERE dc.TenantId = @tenantId
        AND dc.LearnerId = @learnerId
        AND dc.Due <= @now
        AND qq.Kind IN ${RETRIEVAL_KINDS}
        AND ${learnerAccessibleScope()}
      ORDER BY dc.Due ASC`,
    { tenantId, learnerId, now, limit },
  );
  return rows.map((r) => ({
    cardId: r.CardId,
    questionId: r.QuestionId,
    courseId: r.CourseId,
    courseTitle: r.Title,
    courseSlug: r.Slug,
    due: new Date(r.Due),
  }));
}

export async function loadNewPool(
  tenantId: string,
  learnerId: string,
  limit = 20,
): Promise<NewPool[]> {
  const rows = await query<{ QuestionId: string; CourseId: string; Title: string; Slug: string }>(
    `SELECT TOP (@limit)
            CONVERT(varchar(64), qq.QuestionId) AS QuestionId,
            CONVERT(varchar(64), c.CourseId)    AS CourseId,
            c.Title, c.Slug
       FROM lms.Enrollment e
       JOIN lms.Course c        ON c.CourseId  = e.CourseId
       JOIN lms.Lesson l        ON l.CourseId  = c.CourseId
       JOIN lms.Block b         ON b.LessonId  = l.LessonId
       JOIN lms.Quiz q          ON q.BlockId   = b.BlockId
       JOIN lms.QuizQuestion qq ON qq.QuizId   = q.QuizId
      WHERE e.TenantId = @tenantId
        AND e.LearnerId = @learnerId
        AND ${lastCompletedAt("e")} IS NOT NULL
        AND qq.Kind IN ${RETRIEVAL_KINDS}
        AND ${learnerAccessibleScope()}
        AND NOT EXISTS (SELECT 1 FROM lms.DrillCard dc
                         WHERE dc.LearnerId = @learnerId AND dc.QuestionId = qq.QuestionId)
      ORDER BY NEWID()`,
    { tenantId, learnerId, limit },
  );
  return rows.map((r) => ({
    questionId: r.QuestionId,
    courseId: r.CourseId,
    courseTitle: r.Title,
    courseSlug: r.Slug,
  }));
}

export async function loadReasoningPool(
  tenantId: string,
  learnerId: string,
  limit: number,
): Promise<ReasoningPool[]> {
  if (limit <= 0) return [];
  const rows = await query<{ DrillItemId: string; Category: string }>(
    `SELECT TOP (@limit) CONVERT(varchar(64), di.DrillItemId) AS DrillItemId, di.Category
       FROM lms.DrillItem di
      WHERE di.TenantId = @tenantId
        AND di.IsActive = 1
        AND NOT EXISTS (SELECT 1 FROM lms.DrillReview r
                         WHERE r.LearnerId = @learnerId AND r.DrillItemId = di.DrillItemId)
      ORDER BY NEWID()`,
    { tenantId, learnerId, limit },
  );
  return rows.map((r) => ({ drillItemId: r.DrillItemId, category: r.Category }));
}

function idParams(ids: string[]): { list: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const names = ids.map((id, i) => {
    params[`id${i}`] = id;
    return `@id${i}`;
  });
  return { list: names.join(", "), params };
}

export async function loadQuestions(
  tenantId: string,
  learnerId: string,
  questionIds: string[],
): Promise<Map<string, QuizQuestion>> {
  const out = new Map<string, QuizQuestion>();
  if (questionIds.length === 0) return out;
  const { list, params } = idParams(questionIds);
  const rows = await query<{ QuestionId: string; PayloadJson: string }>(
    `SELECT CONVERT(varchar(64), qq.QuestionId) AS QuestionId, qq.PayloadJson
       FROM lms.QuizQuestion qq
       JOIN lms.Quiz q   ON q.QuizId   = qq.QuizId
       JOIN lms.Block b  ON b.BlockId  = q.BlockId
       JOIN lms.Lesson l ON l.LessonId = b.LessonId
       JOIN lms.Course c ON c.CourseId = l.CourseId
      WHERE qq.QuestionId IN (${list})
        AND ${learnerAccessibleScope()}`,
    { tenantId, learnerId, ...params },
  );
  for (const r of rows) {
    const parsed = QuizQuestion.safeParse(JSON.parse(r.PayloadJson));
    if (parsed.success) out.set(r.QuestionId.toLowerCase(), parsed.data);
  }
  return out;
}

export interface ReasoningItem {
  drillItemId: string;
  category: string;
  difficulty: number;
  payload: ReasoningPayload;
}

export async function loadDrillItems(
  tenantId: string,
  ids: string[],
): Promise<Map<string, ReasoningItem>> {
  const out = new Map<string, ReasoningItem>();
  if (ids.length === 0) return out;
  const { list, params } = idParams(ids);
  const rows = await query<{
    DrillItemId: string;
    Category: string;
    Difficulty: number;
    PayloadJson: string;
  }>(
    `SELECT CONVERT(varchar(64), DrillItemId) AS DrillItemId, Category, Difficulty, PayloadJson
       FROM lms.DrillItem
      WHERE TenantId = @tenantId AND DrillItemId IN (${list})`,
    { tenantId, ...params },
  );
  for (const r of rows) {
    const parsed = ReasoningPayload.safeParse(JSON.parse(r.PayloadJson));
    if (!parsed.success) continue;
    out.set(r.DrillItemId.toLowerCase(), {
      drillItemId: r.DrillItemId,
      category: r.Category,
      difficulty: r.Difficulty,
      payload: parsed.data,
    });
  }
  return out;
}

export interface CardRow {
  cardId: string;
  card: Card;
}

function reviveCard(json: string): Card {
  const raw = JSON.parse(json) as Omit<Card, "due" | "last_review"> & {
    due: string;
    last_review?: string | null;
  };
  return {
    ...raw,
    due: new Date(raw.due),
    last_review: raw.last_review ? new Date(raw.last_review) : undefined,
  };
}

export async function getCard(
  tenantId: string,
  learnerId: string,
  questionId: string,
): Promise<CardRow | null> {
  const row = await queryOne<{ CardId: string; FsrsJson: string }>(
    `SELECT CONVERT(varchar(64), CardId) AS CardId, FsrsJson
       FROM lms.DrillCard
      WHERE TenantId = @tenantId AND LearnerId = @learnerId AND QuestionId = @questionId`,
    { tenantId, learnerId, questionId },
  );
  return row ? { cardId: row.CardId, card: reviveCard(row.FsrsJson) } : null;
}

export async function saveCard(
  tenantId: string,
  learnerId: string,
  questionId: string,
  card: Card,
): Promise<string> {
  const existing = await getCard(tenantId, learnerId, questionId);
  const cardId = existing?.cardId ?? randomUUID();
  const params = {
    cardId,
    tenantId,
    learnerId,
    questionId,
    fsrsJson: JSON.stringify(card),
    due: card.due,
    state: card.state,
    reps: card.reps,
    lapses: card.lapses,
    lastReview: card.last_review ?? null,
  };
  if (existing) {
    await execute(
      `UPDATE lms.DrillCard
          SET FsrsJson = @fsrsJson, Due = @due, State = @state, Reps = @reps,
              Lapses = @lapses, LastReview = @lastReview
        WHERE CardId = @cardId AND TenantId = @tenantId AND LearnerId = @learnerId`,
      params,
    );
  } else {
    await execute(
      `INSERT INTO lms.DrillCard
         (CardId, TenantId, LearnerId, QuestionId, FsrsJson, Due, State, Reps, Lapses, LastReview)
       VALUES (@cardId, @tenantId, @learnerId, @questionId, @fsrsJson, @due, @state, @reps, @lapses, @lastReview)`,
      params,
    );
  }
  return cardId;
}

export interface ReviewRow {
  slot: number;
  correct: boolean;
  confidence: number;
  rating: number;
  points: number;
  responseMs: number;
  response: unknown;
  answeredAt: Date;
}

export async function listReviews(tenantId: string, sessionId: string): Promise<ReviewRow[]> {
  const rows = await query<{
    Slot: number;
    Correct: boolean;
    Confidence: number;
    Rating: number;
    Points: number;
    ResponseMs: number;
    ResponseJson: string;
    AnsweredAt: Date;
  }>(
    `SELECT Slot, Correct, Confidence, Rating, Points, ResponseMs, ResponseJson, AnsweredAt
       FROM lms.DrillReview
      WHERE TenantId = @tenantId AND SessionId = @sessionId
      ORDER BY Slot ASC`,
    { tenantId, sessionId },
  );
  return rows.map((r) => ({
    slot: r.Slot,
    correct: Boolean(r.Correct),
    confidence: r.Confidence,
    rating: r.Rating,
    points: r.Points,
    responseMs: r.ResponseMs,
    response: JSON.parse(r.ResponseJson) as unknown,
    answeredAt: r.AnsweredAt,
  }));
}

export interface NewReview {
  sessionId: string;
  tenantId: string;
  learnerId: string;
  slot: number;
  cardId: string | null;
  questionId: string | null;
  drillItemId: string | null;
  response: unknown;
  correct: boolean;
  confidence: number;
  rating: number;
  responseMs: number;
  points: number;
}

/** Returns false when the slot was already answered (unique violation). */
export async function insertReview(r: NewReview): Promise<boolean> {
  try {
    await execute(
      `INSERT INTO lms.DrillReview
         (ReviewId, SessionId, TenantId, LearnerId, Slot, CardId, QuestionId, DrillItemId,
          ResponseJson, Correct, Confidence, Rating, ResponseMs, Points)
       VALUES (@reviewId, @sessionId, @tenantId, @learnerId, @slot, @cardId, @questionId, @drillItemId,
               @responseJson, @correct, @confidence, @rating, @responseMs, @points)`,
      {
        reviewId: randomUUID(),
        sessionId: r.sessionId,
        tenantId: r.tenantId,
        learnerId: r.learnerId,
        slot: r.slot,
        cardId: r.cardId,
        questionId: r.questionId,
        drillItemId: r.drillItemId,
        responseJson: JSON.stringify(r.response ?? null),
        correct: r.correct,
        confidence: r.confidence,
        rating: r.rating,
        responseMs: r.responseMs,
        points: r.points,
      },
    );
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

export async function addSessionPoints(
  tenantId: string,
  sessionId: string,
  points: number,
  correct: boolean,
): Promise<void> {
  await execute(
    `UPDATE lms.DrillSession
        SET Points = Points + @points,
            CorrectCount = CorrectCount + @correctDelta
      WHERE TenantId = @tenantId AND SessionId = @sessionId`,
    { tenantId, sessionId, points, correctDelta: correct ? 1 : 0 },
  );
}

/** Marks the session complete once; returns false if it already was. */
export async function completeSession(
  tenantId: string,
  sessionId: string,
  bonusPoints: number,
): Promise<boolean> {
  const n = await execute(
    `UPDATE lms.DrillSession
        SET CompletedAt = SYSUTCDATETIME(), Points = Points + @bonusPoints
      WHERE TenantId = @tenantId AND SessionId = @sessionId AND CompletedAt IS NULL`,
    { tenantId, sessionId, bonusPoints },
  );
  return n > 0;
}

export interface LearnerStatsRow extends StreakStats {
  totalPoints: number;
  sessionsCompleted: number;
  totalAnswered: number;
  totalCorrect: number;
  certainAnswered: number;
  certainCorrect: number;
}

const EMPTY_STATS: LearnerStatsRow = {
  currentStreak: 0,
  longestStreak: 0,
  lastCompletedLocalDate: null,
  freezesAvailable: 1,
  totalPoints: 0,
  sessionsCompleted: 0,
  totalAnswered: 0,
  totalCorrect: 0,
  certainAnswered: 0,
  certainCorrect: 0,
};

export async function getStats(tenantId: string, learnerId: string): Promise<LearnerStatsRow> {
  const row = await queryOne<{
    CurrentStreak: number;
    LongestStreak: number;
    LastCompletedLocalDate: string | null;
    FreezesAvailable: number;
    TotalPoints: number;
    SessionsCompleted: number;
    TotalAnswered: number;
    TotalCorrect: number;
    CertainAnswered: number;
    CertainCorrect: number;
  }>(
    `SELECT CurrentStreak, LongestStreak,
            CONVERT(varchar(10), LastCompletedLocalDate, 23) AS LastCompletedLocalDate,
            FreezesAvailable, TotalPoints, SessionsCompleted, TotalAnswered, TotalCorrect,
            CertainAnswered, CertainCorrect
       FROM lms.DrillLearnerStats
      WHERE TenantId = @tenantId AND LearnerId = @learnerId`,
    { tenantId, learnerId },
  );
  if (!row) return { ...EMPTY_STATS };
  return {
    currentStreak: row.CurrentStreak,
    longestStreak: row.LongestStreak,
    lastCompletedLocalDate: row.LastCompletedLocalDate,
    freezesAvailable: row.FreezesAvailable,
    totalPoints: row.TotalPoints,
    sessionsCompleted: row.SessionsCompleted,
    totalAnswered: row.TotalAnswered,
    totalCorrect: row.TotalCorrect,
    certainAnswered: row.CertainAnswered,
    certainCorrect: row.CertainCorrect,
  };
}

async function ensureStats(tenantId: string, learnerId: string): Promise<void> {
  await execute(
    `IF NOT EXISTS (SELECT 1 FROM lms.DrillLearnerStats WHERE LearnerId = @learnerId)
       INSERT INTO lms.DrillLearnerStats (LearnerId, TenantId) VALUES (@learnerId, @tenantId)`,
    { tenantId, learnerId },
  );
}

export async function recordAnswerStats(
  tenantId: string,
  learnerId: string,
  correct: boolean,
  confidence: number,
  points: number,
): Promise<void> {
  await ensureStats(tenantId, learnerId);
  await execute(
    `UPDATE lms.DrillLearnerStats
        SET TotalPoints = TotalPoints + @points,
            TotalAnswered = TotalAnswered + 1,
            TotalCorrect = TotalCorrect + @correct,
            CertainAnswered = CertainAnswered + @certain,
            CertainCorrect = CertainCorrect + @certainCorrect,
            UpdatedAt = SYSUTCDATETIME()
      WHERE TenantId = @tenantId AND LearnerId = @learnerId`,
    {
      tenantId,
      learnerId,
      points,
      correct: correct ? 1 : 0,
      certain: confidence === 3 ? 1 : 0,
      certainCorrect: confidence === 3 && correct ? 1 : 0,
    },
  );
}

export async function recordCompletionStats(
  tenantId: string,
  learnerId: string,
  streak: StreakResult,
  bonusPoints: number,
): Promise<void> {
  await ensureStats(tenantId, learnerId);
  await execute(
    `UPDATE lms.DrillLearnerStats
        SET CurrentStreak = @currentStreak,
            LongestStreak = @longestStreak,
            LastCompletedLocalDate = @lastCompleted,
            FreezesAvailable = @freezes,
            TotalPoints = TotalPoints + @bonusPoints,
            SessionsCompleted = SessionsCompleted + 1,
            UpdatedAt = SYSUTCDATETIME()
      WHERE TenantId = @tenantId AND LearnerId = @learnerId`,
    {
      tenantId,
      learnerId,
      currentStreak: streak.currentStreak,
      longestStreak: streak.longestStreak,
      lastCompleted: streak.lastCompletedLocalDate,
      freezes: streak.freezesAvailable,
      bonusPoints,
    },
  );
}

export interface Calibration {
  certainAnswered: number;
  certainCorrect: number;
}

export async function calibration30d(tenantId: string, learnerId: string): Promise<Calibration> {
  const row = await queryOne<{ CertainAnswered: number; CertainCorrect: number }>(
    `SELECT COUNT(*) AS CertainAnswered,
            SUM(CASE WHEN Correct = 1 THEN 1 ELSE 0 END) AS CertainCorrect
       FROM lms.DrillReview
      WHERE TenantId = @tenantId AND LearnerId = @learnerId
        AND Confidence = 3
        AND AnsweredAt >= DATEADD(day, -30, SYSUTCDATETIME())`,
    { tenantId, learnerId },
  );
  return {
    certainAnswered: row?.CertainAnswered ?? 0,
    certainCorrect: row?.CertainCorrect ?? 0,
  };
}

export async function countActiveItems(tenantId: string): Promise<number> {
  const row = await queryOne<{ N: number }>(
    `SELECT COUNT(*) AS N FROM lms.DrillItem WHERE TenantId = @tenantId AND IsActive = 1`,
    { tenantId },
  );
  return row?.N ?? 0;
}

export async function recentItemPrompts(tenantId: string, limit = 40): Promise<string[]> {
  const rows = await query<{ PayloadJson: string }>(
    `SELECT TOP (@limit) PayloadJson FROM lms.DrillItem
      WHERE TenantId = @tenantId ORDER BY CreatedAt DESC`,
    { tenantId, limit },
  );
  const prompts: string[] = [];
  for (const r of rows) {
    const parsed = ReasoningPayload.safeParse(JSON.parse(r.PayloadJson));
    if (parsed.success) prompts.push(parsed.data.promptMd);
  }
  return prompts;
}

export async function insertDrillItems(
  tenantId: string,
  items: Array<{ category: string; difficulty: number; payload: ReasoningPayload }>,
): Promise<number> {
  let n = 0;
  for (const it of items) {
    await execute(
      `INSERT INTO lms.DrillItem (DrillItemId, TenantId, Category, Difficulty, PayloadJson)
       VALUES (@id, @tenantId, @category, @difficulty, @payloadJson)`,
      {
        id: randomUUID(),
        tenantId,
        category: it.category,
        difficulty: it.difficulty,
        payloadJson: JSON.stringify(it.payload),
      },
    );
    n += 1;
  }
  return n;
}

export interface LatestSession {
  localDate: string;
  timeZone: string;
  completed: boolean;
  answered: number;
  total: number;
}

export async function getLatestSession(
  tenantId: string,
  learnerId: string,
): Promise<LatestSession | null> {
  const row = await queryOne<{
    LocalDate: string;
    TimeZone: string;
    CompletedAt: Date | null;
    TotalCount: number;
    Answered: number;
  }>(
    `SELECT TOP 1 CONVERT(varchar(10), s.LocalDate, 23) AS LocalDate, s.TimeZone, s.CompletedAt, s.TotalCount,
            (SELECT COUNT(*) FROM lms.DrillReview r WHERE r.SessionId = s.SessionId) AS Answered
       FROM lms.DrillSession s
      WHERE s.TenantId = @tenantId AND s.LearnerId = @learnerId
      ORDER BY s.LocalDate DESC`,
    { tenantId, learnerId },
  );
  if (!row) return null;
  return {
    localDate: row.LocalDate,
    timeZone: row.TimeZone,
    completed: row.CompletedAt !== null,
    answered: row.Answered,
    total: row.TotalCount,
  };
}

export interface DrillDashboard {
  stats: LearnerStatsRow;
  latest: LatestSession | null;
}

/** Dashboard summary that degrades to null (card hidden) if the drill tables are not there yet. */
export async function getDrillDashboard(
  tenantId: string,
  learnerId: string,
): Promise<DrillDashboard | null> {
  try {
    const [stats, latest] = await Promise.all([
      getStats(tenantId, learnerId),
      getLatestSession(tenantId, learnerId),
    ]);
    return { stats, latest };
  } catch (err) {
    console.error("[drill] dashboard summary unavailable:", err instanceof Error ? err.message : err);
    return null;
  }
}
