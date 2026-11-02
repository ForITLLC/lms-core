import { z } from "zod";
import { noStoreJson, requireTenantStaff, staffRouteFailure } from "@/lib/auth/staff-gate";
import { getDraft, loadOwnVersion, UnreadableDraftError } from "@/lib/db/course-drafts";
import { toDraftDoc, UnreadableVersionError } from "@/lib/builder/fork";
import { previewQuiz } from "@/lib/builder/preview";
import { gradeResponses } from "@/lib/db/quizzes";
import { DRAFT_LIMITS, DraftKey, type DraftDoc } from "@/lib/schema/draft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Grades one quiz in the author preview against the answer key held on the
// server, with the learner grader, and answers what the learner submit route
// answers less its attempt id. It records nothing: no attempt, no progress.
//
// Body: { draftId, revision, blockKey, responses } grades the draft at that
// revision; { draftId: null, versionId, blockKey, responses } grades that
// published version, which never changes, so it has no conflict case.

interface RouteParams {
  params: Promise<{ courseId: string }>;
}

const lower = (id: string) => id.toLowerCase();
const CourseId = z.string().uuid();
const Responses = z
  .array(z.union([z.string().max(4000), z.boolean(), z.array(z.string().max(4000)).max(200), z.null()]))
  .max(DRAFT_LIMITS.questionsPerQuiz);
const Grade = z.union([
  z.object({ draftId: z.string().uuid().transform(lower), revision: z.number().int().min(1), blockKey: DraftKey, responses: Responses }).strict(),
  z.object({ draftId: z.null(), versionId: z.string().uuid().transform(lower), blockKey: DraftKey, responses: Responses }).strict(),
]);
type Grade = z.infer<typeof Grade>;

const notFound = () => noStoreJson({ error: "Course or draft not found" }, 404);

async function docFor(tenantId: string, courseId: string, body: Grade): Promise<DraftDoc | Response> {
  if (body.draftId === null) {
    const content = await loadOwnVersion(tenantId, courseId, body.versionId);
    return content ? toDraftDoc(content) : notFound();
  }
  const draft = await getDraft(tenantId, courseId);
  if (!draft) return notFound();
  if (draft.draftId !== body.draftId || draft.revision !== body.revision) {
    return noStoreJson({ error: "The draft changed after this preview opened. Reload the preview.", code: "draft_conflict" }, 409);
  }
  return draft.doc;
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const gate = await requireTenantStaff();
    if (!gate.ok) return gate.response;
    const id = CourseId.safeParse((await params).courseId);
    if (!id.success) return notFound();
    const parsed = Grade.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return noStoreJson({ error: "Provide the draft id and revision (or a version id), the quiz block key and the answers", code: "invalid" }, 400);
    }

    const doc = await docFor(gate.tenantId, id.data.toLowerCase(), parsed.data);
    if (doc instanceof Response) return doc;
    const quiz = previewQuiz(doc, parsed.data.blockKey);
    if (quiz.kind === "missing") return noStoreJson({ error: "That quiz isn't in this preview", code: "block_not_found" }, 404);
    if (quiz.kind === "not_quiz") return noStoreJson({ error: "That block isn't a quiz", code: "not_a_quiz" }, 422);

    const grade = gradeResponses(quiz.questions, parsed.data.responses);
    return noStoreJson({
      score: grade.score,
      passingScore: quiz.passingScore,
      passed: grade.score >= quiz.passingScore,
      correctCount: grade.correctCount,
      autoGradableCount: grade.autoGradableCount,
      perQuestion: grade.perQuestion.map((p) => ({ orderIndex: p.orderIndex, correct: p.correct })),
    });
  } catch (error) {
    if (error instanceof UnreadableDraftError) {
      return noStoreJson({ error: error.message, code: "unreadable", draftId: error.draftId, revision: error.revision }, 422);
    }
    if (error instanceof UnreadableVersionError) return noStoreJson({ error: error.message, code: "unreadable" }, 422);
    return staffRouteFailure("lms-author", error);
  }
}
