import { z } from "zod";
import {
  claimIngestion,
  claimNextIngestion,
  completeIngestion,
  failIngestion,
  getIngestion,
  pauseIngestion,
  requeueIngestion,
  saveIngestionWork,
  type ClaimedIngestion,
  type IngestionRecord,
  type IngestionStage,
} from "@/lib/db/ingestions";
import { createCourse, IngestionNotHeldError } from "@/lib/db/course-drafts";
import { recordError, recordServiceRun } from "@/lib/logging";
import { transientAiError } from "@/lib/ai/claude";
import { extractYouTube } from "./extract-youtube";
import { checkPastedText, extractText } from "./extract-text";
import { checkPageUrl, extractUrl } from "./extract-url";
import {
  isSourceKind,
  SOURCE_REF_MAX,
  SourceExtract,
  SourceRefusedError,
  SourceUnavailableError,
  youTubeVideoId,
  type SourceKind,
} from "./source";
import { CourseOutline, generateOutline } from "./outline";
import { generateBlocks, type AuthorableBlock, type DroppedBlock } from "./blocks";
import { generateQuiz, type LessonQuiz } from "./quiz";
import { toAuthoredDraft } from "./draft";
import { readJobOptions } from "./options";
import { addUsage, ModelOutputError, readUsage, tokenTotals, type CallUsage } from "./usage";

// The AI authoring job (docs/plans/2026-10-29-ai-authoring.md, slice A2). A
// claimed lms.AssetIngestion row runs through extract, outline, lessons and
// saving. What each stage produces is kept in WorkJson as soon as it exists,
// each lesson as it finishes, so a retry picks up where the last run stopped
// and never pays for a model call twice. Every model call's tokens are added
// to UsageJson's running total the moment it answers, and every write the job
// makes carries that total, so it covers every attempt and counts each call
// once. The job ends at a course builder draft made by createCourse; AI
// authoring never publishes. From A3 the source is a YouTube video, pasted
// text or a public web page (SourceKind); from A4 the author's lesson count
// and quiz choice (OptionsJson) reach the prompts.
const SERVICE = "lms-ai-authoring";

// Azure's front door cuts a request at about 230 s: no new model stage starts
// after this much of a call has gone.
export const STAGE_BUDGET_MS = 200_000;
// A transient error requeues the job three times; the fourth fails it.
export const REQUEUES = 3;
const BACKOFF_BASE_SECONDS = 60;
const BACKOFF_MAX_SECONDS = 15 * 60;

// An extract kept before sources had kinds (A2) reads as the YouTube one it is.
const LegacyYouTubeExtract = z
  .object({
    videoId: z.string(),
    url: z.string(),
    title: z.string(),
    author: z.string(),
    thumbnailUrl: z.string(),
    transcript: z.string(),
    durationApproxSec: z.number(),
    transcriptSource: z.enum(["yt-dlp", "youtube-transcript"]),
  })
  .transform((e): SourceExtract => ({
    kind: "youtube",
    title: e.title,
    author: e.author,
    url: e.url,
    text: e.transcript,
    approxMinutes: Math.round(e.durationApproxSec / 60),
    videoId: e.videoId,
    thumbnailUrl: e.thumbnailUrl,
    transcriptSource: e.transcriptSource,
  }));

const Extract = z.union([SourceExtract, LegacyYouTubeExtract]);

// Blocks and questions are checked as a whole by toAuthoredDraft (DraftDoc)
// before anything is saved.
const LessonWork = z.object({
  blocks: z.array(z.unknown()),
  dropped: z.array(z.object({ lesson: z.number(), position: z.number(), kind: z.string(), reason: z.string() })),
  quiz: z.object({ questions: z.array(z.unknown()) }),
});

const Work = z.object({
  extract: Extract.optional(),
  outline: CourseOutline.optional(),
  lessons: z.array(LessonWork.nullable()).default([]),
});

interface LessonResult {
  blocks: AuthorableBlock[];
  dropped: DroppedBlock[];
  quiz: LessonQuiz;
}

interface JobWork {
  extract?: SourceExtract;
  outline?: CourseOutline;
  lessons: (LessonResult | null)[];
}

export interface Progress {
  ingestionId: string;
  stage: IngestionStage;
  lessonsDone: number;
  lessonsTotal: number | null;
}

export interface CreatedCourse {
  courseId: string;
  slug: string;
  title: string;
  lessonCount: number;
  questionCount: number;
  droppedBlocks: DroppedBlock[];
}

export type JobOutcome =
  | { outcome: "idle" }
  | { outcome: "completed"; ingestionId: string; courseId: string; course: CreatedCourse | null }
  | { outcome: "paused"; ingestionId: string; stage: IngestionStage }
  | { outcome: "requeued"; ingestionId: string; attempts: number; delaySeconds: number; error: string }
  | { outcome: "failed"; ingestionId: string; error: string }
  // Another worker holds the job now; this one wrote nothing more.
  | { outcome: "lease_lost"; ingestionId: string }
  // The course exists and the job holds it, but marking the job complete
  // failed; the next claim after the lease runs out finishes it.
  | { outcome: "interrupted"; ingestionId: string; courseId: string };

export interface RunOptions {
  budgetMs?: number;
  now?: () => number;
  onProgress?: (progress: Progress) => void;
}

// Only a transient model error (lib/ai/claude.ts transientAiError) or a source
// that didn't answer this time (a page timing out, a 5xx or 429) is retried.
// Anything else fails the job at once: no captions, a source refused (a blocked
// address, a page too large or of the wrong type, a paste over the cap), output
// the schemas refuse, a job this worker can't run.
class PermanentJobError extends Error {}

function transientError(err: unknown): { retryAfterMs: number | null } | null {
  if (err instanceof SourceUnavailableError) return { retryAfterMs: err.retryAfterMs };
  return transientAiError(err);
}
class LeaseLostError extends Error {}

type Meter = <T extends { usage: CallUsage }>(call: Promise<T>) => Promise<T>;

export async function processNextIngestion(options: RunOptions = {}): Promise<JobOutcome> {
  const job = await claimNextIngestion();
  return job ? runIngestion(job, options) : { outcome: "idle" };
}

export async function runIngestion(job: ClaimedIngestion, options: RunOptions = {}): Promise<JobOutcome> {
  const now = options.now ?? Date.now;
  const started = now();
  const budget = options.budgetMs ?? STAGE_BUDGET_MS;
  const { ingestionId, tenantId } = job;
  const run = `${job.sourceKind} tenant=${tenantId} ingestion=${ingestionId} attempt=${job.attempts}`;
  const work = readWork(job.workJson);
  const asked = readJobOptions(job.optionsJson);
  let stage: IngestionStage = stageOf(work);
  let courseId = job.resultCourseId;
  let usage = readUsage(job.usageJson);
  const usageJson = () => JSON.stringify(usage);
  const tokens = () => {
    const { tokensIn, tokensOut } = tokenTotals(usage);
    return `tokens in=${tokensIn} out=${tokensOut}`;
  };
  // A call's tokens count when it answers, whether or not the job can use
  // what it said: output the schemas refuse was paid for too.
  const metered: Meter = async (call) => {
    try {
      const result = await call;
      usage = addUsage(usage, result.usage);
      return result;
    } catch (err) {
      if (err instanceof ModelOutputError) usage = addUsage(usage, err.usage);
      throw err;
    }
  };

  const lessonsDone = () => work.lessons.filter(Boolean).length;
  const dropped = () => work.lessons.flatMap((lesson) => lesson?.dropped ?? []);
  // Lessons finish in parallel; their writes go one at a time, each with the
  // whole work so far, so the last write holds every finished lesson.
  let writes: Promise<void> = Promise.resolve();
  const save = (next: IngestionStage) => {
    const write = writes.then(async () => {
      const progress = { ingestionId, stage: next, lessonsDone: lessonsDone(), lessonsTotal: work.outline?.lessons.length ?? null };
      const kept = await saveIngestionWork(job, {
        stage: next,
        workJson: JSON.stringify(work),
        lessonsDone: progress.lessonsDone,
        lessonsTotal: progress.lessonsTotal,
        warningsJson: JSON.stringify(dropped()),
        usageJson: usageJson(),
      });
      if (!kept) throw new LeaseLostError();
      options.onProgress?.(progress);
    });
    writes = write.catch(() => undefined);
    return write;
  };

  try {
    if (!courseId) {
      if (job.attempts > REQUEUES + 1) {
        throw new PermanentJobError(`Stopped after ${job.attempts - 1} attempts; the last one never finished.`);
      }
      if (!isSourceKind(job.sourceKind)) throw new PermanentJobError(`Unsupported source kind '${job.sourceKind}'.`);
      if (!job.createdBy) throw new PermanentJobError("The job records no author.");
      const createdBy = job.createdBy;

      while (stage !== "saving") {
        if (now() - started >= budget) {
          if (!(await pauseIngestion(job, usageJson()))) throw new LeaseLostError();
          return { outcome: "paused", ingestionId, stage };
        }
        if (stage === "extract") {
          work.extract = await extractSource(job);
          stage = "outline";
          await save(stage);
        } else if (stage === "outline") {
          const { usage: _spent, ...generated } = await metered(generateOutline(work.extract!, { lessonCount: asked.lessonCount }));
          work.outline = generated;
          work.lessons = work.outline.lessons.map(() => null);
          stage = "lessons";
          await save(stage);
        } else {
          await generateLessons(work, save, metered, asked.quizzes);
          stage = "saving";
          await save(stage);
        }
      }

      const outline = work.outline!;
      const doc = toAuthoredDraft(outline, outline.lessons.map((lesson, i) => ({ lesson, ...work.lessons[i]! })));
      const created = await createCourse(tenantId, createdBy, {
        title: doc.meta.title,
        description: doc.meta.description,
        slug: outline.slug,
        lessons: doc.lessons,
        ingestion: { ingestionId, leaseToken: job.leaseToken },
      });
      courseId = created.courseId;
      return await finish(courseId, { slug: created.slug, title: doc.meta.title });
    }
    // An earlier run made the course and stopped before marking the job done.
    return await finish(courseId, null);
  } catch (err) {
    return await failure(err);
  }

  async function finish(id: string, made: { slug: string; title: string } | null): Promise<JobOutcome> {
    if (!(await completeIngestion(job, usageJson()))) throw new LeaseLostError();
    const droppedBlocks = dropped();
    const questionCount = work.lessons.reduce((n, lesson) => n + (lesson?.quiz.questions.length ?? 0), 0);
    const lessonCount = work.outline?.lessons.length ?? 0;
    await recordServiceRun(
      SERVICE,
      droppedBlocks.length ? "PARTIAL" : "SUCCESS",
      now() - started,
      lessonCount,
      `${run} course=${id} questions=${questionCount} dropped=${describeDropped(droppedBlocks).slice(0, 3500)} ${tokens()}`,
      droppedBlocks.length,
    );
    const course = made ? { courseId: id, ...made, lessonCount, questionCount, droppedBlocks } : null;
    return { outcome: "completed", ingestionId, courseId: id, course };
  }

  async function failure(err: unknown): Promise<JobOutcome> {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof LeaseLostError || err instanceof IngestionNotHeldError) return notOurs();
    if (courseId) {
      await recordError(SERVICE, `${run} course=${courseId} not marked complete: ${msg}`, "ERROR", stackOf(err));
      return { outcome: "interrupted", ingestionId, courseId };
    }
    const transient = transientError(err);
    if (transient && job.attempts <= REQUEUES) {
      const delaySeconds = backoffSeconds(job.attempts, transient.retryAfterMs);
      if (!(await requeueIngestion(job, delaySeconds, msg, usageJson()))) return notOurs();
      await recordError(SERVICE, `${run} requeued in ${delaySeconds}s: ${msg}`, "WARNING");
      return { outcome: "requeued", ingestionId, attempts: job.attempts, delaySeconds, error: msg };
    }
    const error = transient ? `Gave up after ${job.attempts} attempts: ${msg}` : msg;
    if (!(await failIngestion(job, error, usageJson()))) return notOurs();
    await recordError(SERVICE, `${run}: ${error}`, "ERROR", stackOf(err));
    await recordServiceRun(SERVICE, "FAILURE", now() - started, 0, `${run}: ${error.slice(0, 3500)} ${tokens()}`, 1);
    return { outcome: "failed", ingestionId, error };
  }

  // The lease was taken, or a course the job made is already stamped on it
  // (its commit landed but the answer was lost): the next claim finishes it.
  async function notOurs(): Promise<JobOutcome> {
    await recordError(SERVICE, `${run}: the job is no longer this worker's to change; it stopped`, "WARNING");
    return { outcome: "lease_lost", ingestionId };
  }
}

// Every lesson not yet in the work, in parallel; each is saved as it
// finishes, so one that fails doesn't cost the others. A lesson waits for
// both its calls before it fails, so the tokens of the one that answered are
// counted before the job writes its failure. With quizzes off the quiz call is
// never made, and the lesson keeps an empty quiz that the draft leaves out.
async function generateLessons(
  work: JobWork,
  save: (stage: IngestionStage) => Promise<void>,
  metered: Meter,
  quizzes: boolean,
): Promise<void> {
  const extract = work.extract!;
  const outline = work.outline!;
  const settled = await Promise.allSettled(
    outline.lessons.map(async (lesson, i) => {
      if (work.lessons[i]) return;
      const calls = await Promise.allSettled([
        metered(generateBlocks({ extract, courseTitle: outline.title, lesson, lessonIndex: i, totalLessons: outline.lessons.length })),
        quizzes
          ? metered(generateQuiz({ extract, courseTitle: outline.title, lesson, lessonIndex: i }))
          : Promise.resolve<LessonQuiz>({ questions: [] }),
      ]);
      const [made, quiz] = calls;
      if (made.status === "rejected" || quiz.status === "rejected") throw firstFailure(rejections(calls));
      work.lessons[i] = { blocks: made.value.blocks, dropped: made.value.dropped, quiz: { questions: quiz.value.questions } };
      await save("lessons");
    }),
  );
  const failures = rejections(settled);
  if (failures.length > 0) throw firstFailure(failures);
}

function rejections(settled: PromiseSettledResult<unknown>[]): unknown[] {
  return settled.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
}

// A lost lease stops the job; a refusal fails it even when another call only
// hit a rate limit.
function firstFailure(failures: unknown[]): unknown {
  return failures.find((reason) => reason instanceof LeaseLostError)
    ?? failures.find((reason) => !transientError(reason))
    ?? failures[0];
}

// The source as the job's kind reads it. Pasted text rides in OptionsJson.
async function extractSource(job: ClaimedIngestion): Promise<SourceExtract> {
  switch (job.sourceKind as SourceKind) {
    case "youtube":
      return extractYouTube(job.sourceRef);
    case "url":
      return extractUrl(job.sourceRef);
    case "text":
      return extractText(pastedSource(job.optionsJson));
  }
  throw new PermanentJobError(`Unsupported source kind '${job.sourceKind}'.`);
}

function pastedSource(optionsJson: string | null): { title?: unknown; text?: unknown } {
  let options: unknown;
  try {
    options = JSON.parse(optionsJson ?? "null");
  } catch {
    options = null;
  }
  const source = options && typeof options === "object" ? (options as { source?: unknown }).source : undefined;
  if (!source || typeof source !== "object") throw new SourceRefusedError("The job holds no pasted text.");
  return source as { title?: unknown; text?: unknown };
}

export type SourceInput =
  | { kind: "youtube"; url: string }
  | { kind: "url"; url: string }
  | { kind: "text"; title: string; text: string };

export interface IngestionInput {
  createdBy: string;
  sourceKind: SourceKind;
  sourceRef: string;
  options: Record<string, unknown>;
}

// What enqueueIngestion takes for a source, checked as far as it can be before
// the job runs; a bad source throws SourceRefusedError. A web address naming a
// YouTube video becomes a YouTube source. Pasted text rides in OptionsJson
// (never returned by the status read) and SourceRef holds its title.
export function ingestionInput(createdBy: string, source: SourceInput, options: Record<string, unknown> = {}): IngestionInput {
  if (source.kind === "text") {
    const paste = checkPastedText(source);
    return { createdBy, sourceKind: "text", sourceRef: paste.title, options: { ...options, source: paste } };
  }
  if (source.kind !== "youtube" && source.kind !== "url") {
    throw new SourceRefusedError(`Unsupported source kind '${(source as { kind: unknown }).kind}'.`);
  }
  if (typeof source.url !== "string") throw new SourceRefusedError("The source needs a web address.");
  const url = source.url.trim();
  if (youTubeVideoId(url)) {
    if (url.length > SOURCE_REF_MAX) throw new SourceRefusedError(`The web address is over ${SOURCE_REF_MAX} characters.`);
    return { createdBy, sourceKind: "youtube", sourceRef: url, options };
  }
  if (source.kind === "youtube") throw new SourceRefusedError("That is not a YouTube video address.");
  return { createdBy, sourceKind: "url", sourceRef: checkPageUrl(url), options };
}

// What the job has done is what its work holds, whatever the Stage column says.
function stageOf(work: JobWork): IngestionStage {
  if (!work.extract) return "extract";
  if (!work.outline) return "outline";
  if (work.lessons.some((lesson) => !lesson)) return "lessons";
  return "saving";
}

// Work the schema no longer reads starts over from the source.
function readWork(json: string | null): JobWork {
  if (!json) return { lessons: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { lessons: [] };
  }
  const parsed = Work.safeParse(raw);
  if (!parsed.success) return { lessons: [] };
  const work = parsed.data as JobWork;
  if (!work.outline || work.lessons.length !== work.outline.lessons.length) {
    work.lessons = work.outline ? work.outline.lessons.map(() => null) : [];
  }
  return work;
}

export function backoffSeconds(attempt: number, retryAfterMs: number | null): number {
  const doubled = BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempt - 1);
  const hinted = retryAfterMs ? Math.ceil(retryAfterMs / 1000) : 0;
  return Math.min(BACKOFF_MAX_SECONDS, Math.max(doubled, hinted));
}

function describeDropped(dropped: DroppedBlock[]): string {
  if (dropped.length === 0) return "0";
  return `${dropped.length} (${dropped.map((d) => `lesson ${d.lesson} block ${d.position} ${d.kind}: ${d.reason}`).join("; ")})`;
}

function stackOf(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}

export interface InlineResult {
  ingestion: IngestionRecord;
  course: CreatedCourse | null;
}

export interface InlineOptions extends Omit<RunOptions, "budgetMs"> {
  sleep?: (ms: number) => Promise<void>;
  onWait?: (ingestion: IngestionRecord, ms: number) => void;
}

// Runs one tenant's job here until it ends, through the same processor the
// cron worker uses: claim it when it is due, run it with no time budget, wait
// out a retry delay, and let a cron worker that claimed it first finish it.
export async function runIngestionInline(
  tenantId: string,
  ingestionId: string,
  options: InlineOptions = {},
): Promise<InlineResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let course: CreatedCourse | null = null;
  for (;;) {
    const job = await claimIngestion(tenantId, ingestionId);
    if (job) {
      const result = await runIngestion(job, { ...options, budgetMs: Number.POSITIVE_INFINITY });
      if (result.outcome === "completed") course = result.course;
    }
    const ingestion = await getIngestion(tenantId, ingestionId);
    if (!ingestion) throw new Error(`Ingestion ${ingestionId} not found for this tenant`);
    if (ingestion.status !== "queued" && ingestion.status !== "running") return { ingestion, course };
    const due = ingestion.status === "queued" ? ingestion.notBefore.getTime() - now() : 15_000;
    const ms = Math.min(Math.max(due, 1_000), BACKOFF_MAX_SECONDS * 1000);
    options.onWait?.(ingestion, ms);
    await sleep(ms);
  }
}
