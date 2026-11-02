import { z } from "zod";
import { DraftBlock, DraftDoc, DraftKey, DraftLesson, DraftMeta } from "@/lib/schema/draft";

// The edits the course editor sends. Each save carries a short list of them
// and the draft revision it was made against; applyDraftOps is the whole of
// what they can do to a draft.
const Index = z.number().int().min(0);

export const DraftOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("setMeta"), meta: DraftMeta.partial() }),
  z.object({ op: z.literal("addLesson"), lesson: DraftLesson, at: Index.optional() }),
  z.object({
    op: z.literal("updateLesson"),
    lessonKey: DraftKey,
    title: DraftLesson.shape.title.optional(),
    estMinutes: DraftLesson.shape.estMinutes.optional(),
  }),
  z.object({ op: z.literal("removeLesson"), lessonKey: DraftKey }),
  z.object({ op: z.literal("moveLesson"), lessonKey: DraftKey, to: Index }),
  z.object({ op: z.literal("addBlock"), lessonKey: DraftKey, block: DraftBlock, at: Index.optional() }),
  z.object({ op: z.literal("updateBlock"), lessonKey: DraftKey, block: DraftBlock }),
  z.object({ op: z.literal("removeBlock"), lessonKey: DraftKey, blockKey: DraftKey }),
  z.object({
    op: z.literal("moveBlock"),
    lessonKey: DraftKey,
    blockKey: DraftKey,
    toLessonKey: DraftKey.optional(),
    to: Index,
  }),
]);
export type DraftOp = z.infer<typeof DraftOp>;

export const DraftOps = z.array(DraftOp).min(1).max(200);

export type ApplyResult = { ok: true; doc: DraftDoc } | { ok: false; error: string };

const PACKAGE_READ_ONLY = "A package block comes from an imported package and can't be edited here.";

export function applyDraftOps(doc: DraftDoc, ops: DraftOp[]): ApplyResult {
  const next: DraftDoc = structuredClone(doc);
  for (const op of ops) {
    const error = applyOne(next, op);
    if (error) return { ok: false, error };
  }
  const parsed = DraftDoc.safeParse(next);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "the draft is not valid" };
  return { ok: true, doc: parsed.data };
}

function applyOne(doc: DraftDoc, op: DraftOp): string | null {
  switch (op.op) {
    case "setMeta": {
      const defined = Object.fromEntries(Object.entries(op.meta).filter(([, v]) => v !== undefined));
      doc.meta = { ...doc.meta, ...defined };
      return null;
    }
    case "addLesson": {
      if (op.lesson.blocks.some((b) => b.kind === "package")) return PACKAGE_READ_ONLY;
      insertAt(doc.lessons, op.lesson, op.at);
      return null;
    }
    case "updateLesson": {
      const lesson = findLesson(doc, op.lessonKey);
      if (!lesson) return noLesson(op.lessonKey);
      if (op.title !== undefined) lesson.title = op.title;
      if (op.estMinutes !== undefined) lesson.estMinutes = op.estMinutes;
      return null;
    }
    case "removeLesson": {
      const at = doc.lessons.findIndex((l) => l.key === op.lessonKey);
      if (at < 0) return noLesson(op.lessonKey);
      doc.lessons.splice(at, 1);
      return null;
    }
    case "moveLesson": {
      const at = doc.lessons.findIndex((l) => l.key === op.lessonKey);
      if (at < 0) return noLesson(op.lessonKey);
      const [lesson] = doc.lessons.splice(at, 1);
      insertAt(doc.lessons, lesson!, op.to);
      return null;
    }
    case "addBlock": {
      if (op.block.kind === "package") return PACKAGE_READ_ONLY;
      const lesson = findLesson(doc, op.lessonKey);
      if (!lesson) return noLesson(op.lessonKey);
      insertAt(lesson.blocks, op.block, op.at);
      return null;
    }
    case "updateBlock": {
      const lesson = findLesson(doc, op.lessonKey);
      if (!lesson) return noLesson(op.lessonKey);
      const at = lesson.blocks.findIndex((b) => b.key === op.block.key);
      if (at < 0) return noBlock(op.block.key);
      if (lesson.blocks[at]!.kind === "package" || op.block.kind === "package") return PACKAGE_READ_ONLY;
      lesson.blocks[at] = op.block;
      return null;
    }
    case "removeBlock": {
      const lesson = findLesson(doc, op.lessonKey);
      if (!lesson) return noLesson(op.lessonKey);
      const at = lesson.blocks.findIndex((b) => b.key === op.blockKey);
      if (at < 0) return noBlock(op.blockKey);
      lesson.blocks.splice(at, 1);
      return null;
    }
    case "moveBlock": {
      const from = findLesson(doc, op.lessonKey);
      if (!from) return noLesson(op.lessonKey);
      const to = op.toLessonKey ? findLesson(doc, op.toLessonKey) : from;
      if (!to) return noLesson(op.toLessonKey!);
      const at = from.blocks.findIndex((b) => b.key === op.blockKey);
      if (at < 0) return noBlock(op.blockKey);
      const [block] = from.blocks.splice(at, 1);
      insertAt(to.blocks, block!, op.to);
      return null;
    }
  }
}

function findLesson(doc: DraftDoc, key: string): DraftLesson | undefined {
  return doc.lessons.find((l) => l.key === key);
}

function insertAt<T>(list: T[], item: T, at: number | undefined): void {
  list.splice(Math.min(at ?? list.length, list.length), 0, item);
}

const noLesson = (key: string) => `No lesson ${key} in this draft.`;
const noBlock = (key: string) => `No block ${key} in that lesson.`;
