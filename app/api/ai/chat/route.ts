import { NextResponse } from "next/server";
import { recordError, recordServiceRun } from "@/lib/logging";
import { getClaude, MODELS, buildCachedSystem } from "@/lib/ai/claude";
import { courseCorpus, TutorRequest, tutorQuestion } from "@/lib/ai/context";
import { tutorLimiter } from "@/lib/ai/rate-limit";
import { requireSessionUser } from "@/lib/get-session";
import { getCourseBySlug } from "@/lib/db/courses";
import { resolveLearner } from "@/lib/db/progress";
import { resolveLearnerVersion } from "@/lib/db/versions";
import { getTenantContentTokens } from "@/lib/db/tenants";
import { resolveCourseTokens } from "@/lib/tenant-tokens";
import { stripBlock } from "@/lib/mobile/course";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVICE = "lms-ai-tutor";
const FAILED = "The tutor couldn't answer just now. Try again in a moment.";

export async function POST(req: Request) {
  const started = Date.now();
  let session;
  try {
    session = await requireSessionUser();
  } catch {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  const tenantId = session.tenantId;
  if (!tenantId) {
    return NextResponse.json({ error: "Your session isn't bound to a tenant" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = TutorRequest.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { message, courseSlug, lessonId } = parsed.data;

  const waitMs = tutorLimiter.take(`${tenantId}:${session.azureOid}`.toLowerCase());
  if (waitMs > 0) {
    return NextResponse.json(
      { error: "You've asked a lot of questions in a short time. Try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(waitMs / 1000)) } },
    );
  }

  // The course, version and tokens the learner's player shows them. Opening a
  // renewal that has come due stays with the player; the tutor only reads.
  const learner = await resolveLearner(tenantId, session.email, session.name ?? session.email, session.azureOid);
  const preview = await getCourseBySlug(tenantId, courseSlug, { learnerId: learner.learnerId });
  if (!preview) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  const pinnedVersion = await resolveLearnerVersion(learner.learnerId, preview.course.CourseId);
  const loaded = pinnedVersion && pinnedVersion !== preview.versionId
    ? await getCourseBySlug(tenantId, courseSlug, { learnerId: learner.learnerId }, pinnedVersion)
    : preview;
  if (!loaded) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  const detail = resolveCourseTokens(loaded, await getTenantContentTokens(tenantId));
  const lessons = detail.lessons.map((l) => ({ lessonId: l.LessonId, title: l.Title, blocks: l.blocks.map(stripBlock) }));
  const lesson = lessonId ? lessons.find((l) => l.lessonId.toLowerCase() === lessonId.toLowerCase()) : undefined;
  if (lessonId && !lesson) {
    return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
  }

  const claude = getClaude();
  const system = buildCachedSystem(
    [
      "You are an AI tutor inside a learning platform. Answer questions strictly from the course corpus provided.",
      "If the answer is not in the corpus, say so and offer to summarize what is covered.",
      "Do not answer quiz or assessment questions for the learner; help them understand the material instead.",
      `\n--- Course corpus ---\n${courseCorpus(detail.course.Title, lessons, lesson?.lessonId)}`,
    ].join("\n"),
  );

  const run = `tenant=${tenantId} course=${courseSlug}`;
  const failed = (e: unknown) => {
    const err = e instanceof Error ? e : new Error(String(e));
    void recordError(SERVICE, `${run}: ${err.message}`, "ERROR", err.stack).catch(() => {});
    void recordServiceRun(SERVICE, "FAILURE", Date.now() - started, 0, run, 1).catch(() => {});
  };

  let stream;
  try {
    stream = await claude.messages.stream({
      model: MODELS.reasoning,
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: tutorQuestion(lesson?.title ?? null, message) }],
    });
  } catch (e) {
    failed(e);
    return NextResponse.json({ error: FAILED }, { status: 502 });
  }

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`));
          }
        }
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        void recordServiceRun(SERVICE, "SUCCESS", Date.now() - started, 1, run).catch(() => {});
      } catch (e) {
        failed(e);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: FAILED })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
