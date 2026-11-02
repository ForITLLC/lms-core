import type { DraftOp } from "@/lib/builder/draft-ops";
import { DRAFT_LIMITS, META_LIMITS, type DraftBlock, type DraftLesson, type DraftMeta } from "@/lib/schema/draft";
import type { QuizQuestion } from "@/lib/schema/quiz";
import { isImageSource, isWebUrl } from "@/lib/schema/url";

export type BlockKind = DraftBlock["kind"];
export type BlockOf<K extends BlockKind> = Extract<DraftBlock, { kind: K }>;
export type EditableBlock = Exclude<DraftBlock, { kind: "package" }>;
export type QuestionOf<K extends QuizQuestion["kind"]> = Extract<QuizQuestion, { kind: K }>;
export type ChoiceQuestion = QuestionOf<"mcq" | "multi" | "confidence">;
export type Choice = ChoiceQuestion["choices"][number];

export const BLOCK_LABELS: Record<BlockKind, string> = {
  text: "Text",
  callout: "Callout",
  image: "Image",
  video: "Video",
  embed: "Embed",
  quiz: "Quiz",
  roleplay: "Role-play",
  package: "Package",
};

export const CALLOUT_LABELS: Record<BlockOf<"callout">["variant"], string> = {
  info: "Info",
  warning: "Warning",
  success: "Key insight",
  tip: "Pro tip",
};

export const CALLOUT_PALETTE: Record<BlockOf<"callout">["variant"], string> = {
  info: "bg-blue-50 border-blue-200 text-blue-900",
  warning: "bg-amber-50 border-amber-200 text-amber-900",
  success: "bg-emerald-50 border-emerald-200 text-emerald-900",
  tip: "bg-violet-50 border-violet-200 text-violet-900",
};

export const EMBED_PROVIDERS: BlockOf<"embed">["provider"][] = ["youtube", "vimeo", "loom", "other"];

export const PACKAGE_STANDARDS: Record<BlockOf<"package">["standard"], string> = {
  scorm12: "SCORM 1.2",
  scorm2004: "SCORM 2004",
  cmi5: "cmi5",
};

export const QUESTION_LABELS: Record<QuizQuestion["kind"], string> = {
  tf: "True or false",
  mcq: "Multiple choice",
  multi: "Pick all that apply",
  confidence: "Multiple choice with confidence",
  short: "Short answer",
};

// Editor keys must match DraftKey in lib/schema/draft.ts.
export function newKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12) || "k"}`;
}

export function newLesson(title: string): DraftLesson {
  return { key: newKey(), title, estMinutes: null, blocks: [] };
}

export type BlankKind = "text" | "callout" | "quiz" | "roleplay";

export function blankBlock(kind: BlankKind): EditableBlock {
  const key = newKey();
  switch (kind) {
    case "text":
      return { kind, key, markdown: "" };
    case "callout":
      return { kind, key, variant: "info", markdown: "" };
    case "quiz":
      return { kind, key, passingScore: 70, isExam: false, questions: [] };
    case "roleplay":
      return { kind, key, persona: "", scenario: "", rubricMd: "" };
  }
}

// A package block can't be added in the editor, so removing one is only undone
// by discarding the draft.
export function removeBlockPrompt(block: DraftBlock): string {
  if (block.kind === "package") {
    return `Remove the imported package "${block.title}"? Packages only come from an import, so the way to get it back is to discard this draft.`;
  }
  return `Remove this ${BLOCK_LABELS[block.kind].toLowerCase()} block?`;
}

export function blankQuestion(kind: "tf" | "mcq"): QuizQuestion {
  if (kind === "tf") return { kind, promptMd: "", correctValue: true };
  return { kind, promptMd: "", choices: [{ id: "a", label: "" }, { id: "b", label: "" }], correctChoiceId: "a" };
}

export function nextChoiceId(choices: Choice[]): string {
  const used = new Set(choices.map((c) => c.id));
  for (const letter of "abcdefghijklmnopqrstuvwxyz") if (!used.has(letter)) return letter;
  return newKey().slice(0, 8);
}

export { isImageSource, isWebUrl };

export function guessProvider(url: string): BlockOf<"embed">["provider"] {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (host === "youtu.be" || host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) return "youtube";
  if (host.endsWith("vimeo.com")) return "vimeo";
  if (host.endsWith("loom.com")) return "loom";
  return "other";
}

// What stops a block saving at all; publishProblems on the server covers
// what stops it publishing.
export function blockSaveError(block: EditableBlock): string | null {
  switch (block.kind) {
    case "image":
      return isImageSource(block.url) ? null : "Enter a full web address (https://…) or a path starting with /.";
    case "video":
    case "embed":
      return isWebUrl(block.url) ? null : "Enter a full web address starting with https://.";
    case "quiz": {
      if (!wholeNumberIn(block.passingScore, 1, 100)) return "The passing score must be a whole number from 1 to 100.";
      if (block.questions.length > DRAFT_LIMITS.questionsPerQuiz) return questionLimit(block.questions.length);
      const badMarks = block.questions.findIndex((q) => q.kind === "short" && !wholeNumberIn(q.maxScore, 1, 100));
      return badMarks < 0 ? null : `Question ${badMarks + 1}: the marks must be a whole number from 1 to 100.`;
    }
    default:
      return null;
  }
}

function wholeNumberIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

// A number box passes on whatever was typed, so a value out of range reaches
// the block and blockSaveError refuses it instead of the old value saving.
export function parseNumberText(text: string, optional: boolean): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return optional ? null : Number.NaN;
  return Number(trimmed);
}

export function numberText(value: number | null): string {
  return value === null || Number.isNaN(value) ? "" : String(value);
}

export function numberTextError(text: string, min: number, max: number, optional: boolean): string | null {
  const value = parseNumberText(text, optional);
  return value === null || wholeNumberIn(value, min, max) ? null : `Enter a whole number from ${min} to ${max}.`;
}

export const lessonLimit = (count: number) =>
  count >= DRAFT_LIMITS.lessons ? `A course can have up to ${DRAFT_LIMITS.lessons} lessons.` : null;

export const blockLimit = (count: number) =>
  count >= DRAFT_LIMITS.blocksPerLesson ? `A lesson can have up to ${DRAFT_LIMITS.blocksPerLesson} blocks. Add another lesson for more.` : null;

export const questionLimit = (count: number) =>
  count >= DRAFT_LIMITS.questionsPerQuiz ? `A quiz can have up to ${DRAFT_LIMITS.questionsPerQuiz} questions.` : null;

const LAYOUT_OPS = new Set<DraftOp["op"]>(["addLesson", "removeLesson", "moveLesson", "addBlock", "removeBlock", "moveBlock"]);

// Move and remove buttons work out their target from the doc on screen, so
// they wait for an earlier layout change to land; a text edit doesn't move
// anything and the save queue orders it.
export function isLayoutOp(op: DraftOp): boolean {
  return LAYOUT_OPS.has(op.op);
}

export function toggledSet(set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> {
  if (set.has(key) === on) return set;
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

export interface SaveState {
  saving: boolean;
  conflict: boolean;
  saveFailed: boolean;
  dirty: boolean;
}

export function saveStatusLabel({ saving, conflict, saveFailed, dirty }: SaveState): string {
  if (saving) return "Saving…";
  if (conflict || saveFailed) return "Not saved";
  if (dirty) return "Unsaved changes";
  return "All changes saved";
}

export function hasUnsavedWork({ saving, saveFailed, dirty }: SaveState): boolean {
  return saving || saveFailed || dirty;
}

export function publishBlockReason({ locked, dirty }: { locked: boolean; dirty: boolean }): string | null {
  if (locked) return "Reload the draft before publishing.";
  if (dirty) return "Save or cancel your open edits before publishing.";
  return null;
}

// A field edited locally and saved to the draft. `sent` is what the server will
// hold once queued saves land; `server` is what it last answered. A server
// answer replaces the field only while nothing has been typed since the last
// send, so text typed during a save is never overwritten by the reply.
export interface SyncedField<T> {
  local: T;
  sent: T;
  server: T;
}

export type Same<T> = (a: T, b: T) => boolean;

export function syncedField<T>(server: T): SyncedField<T> {
  return { local: server, sent: server, server };
}

export function resyncField<T>(field: SyncedField<T>, incoming: T, same: Same<T> = Object.is): SyncedField<T> {
  if (same(field.local, field.sent)) {
    return same(field.local, incoming) && same(field.server, incoming) ? field : syncedField(incoming);
  }
  return same(field.sent, incoming) && same(field.server, incoming) ? field : { local: field.local, sent: incoming, server: incoming };
}

export function sentField<T>(field: SyncedField<T>): SyncedField<T> {
  return { ...field, sent: field.local };
}

// A failed save leaves the server as it was, so the typed value counts as unsent again.
export function failedField<T>(field: SyncedField<T>): SyncedField<T> {
  return { ...field, sent: field.server };
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function moved<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export type ScheduleChoice = "none" | "annual" | "recurring";

export const SCHEDULE_OPTIONS: { value: ScheduleChoice; label: string }[] = [
  { value: "none", label: "Doesn't expire" },
  { value: "annual", label: "Every year, by January 31" },
  { value: "recurring", label: "Every set number of months" },
];

// lib/db/schedule.ts computeCertExpiresAt.
export const SCHEDULE_HINTS: Record<ScheduleChoice, string> = {
  none: "Certificates never expire.",
  annual: "Certificates expire on January 31 of the year after they're earned.",
  recurring: "Certificates expire this many months after they're earned.",
};

export const scheduleChoice = (kind: DraftMeta["scheduleKind"]): ScheduleChoice => kind ?? "none";

export type TagsResult = { ok: true; tags: string[] } | { ok: false; error: string };

// Commas separate tags, so a pasted list adds each one. A tag already on the
// course, in any case, is skipped.
export function addTags(tags: readonly string[], text: string): TagsResult {
  const next = [...tags];
  for (const piece of text.split(",")) {
    const tag = piece.trim().replace(/\s+/g, " ");
    if (!tag || next.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
    if (tag.length > META_LIMITS.tag) return { ok: false, error: `A tag can be up to ${META_LIMITS.tag} characters.` };
    if (next.length >= META_LIMITS.tags) return { ok: false, error: `A course can have up to ${META_LIMITS.tags} tags.` };
    next.push(tag);
  }
  return { ok: true, tags: next };
}

export const removeTag = (tags: readonly string[], tag: string): string[] => tags.filter((t) => t !== tag);

export interface SettingsForm {
  category: string;
  tags: string[];
  schedule: ScheduleChoice;
  recurrenceMonths: number | null;
  requiresQuizPass: boolean;
  pendingTag: string;
}

export type SettingsMeta = Pick<DraftMeta, "category" | "tags" | "scheduleKind" | "recurrenceMonths" | "requiresQuizPass">;

// The setMeta edit the settings panel sends, or why it can't be sent. Anything
// it returns passes DraftMeta; a recurring course with no months still saves,
// and publishProblems holds it back from publishing. Months only count for a
// recurring course, as at publish.
export function settingsPatch(form: SettingsForm): { ok: true; meta: SettingsMeta } | { ok: false; error: string } {
  const category = form.category.trim();
  if (category.length > META_LIMITS.category) {
    return { ok: false, error: `The category can be up to ${META_LIMITS.category} characters.` };
  }
  const tags = addTags(form.tags, form.pendingTag);
  if (!tags.ok) return tags;
  const recurring = form.schedule === "recurring";
  const months = recurring ? form.recurrenceMonths : null;
  if (months !== null && !wholeNumberIn(months, 1, META_LIMITS.recurrenceMonths)) {
    return { ok: false, error: `Enter the months between renewals as a whole number from 1 to ${META_LIMITS.recurrenceMonths}.` };
  }
  return {
    ok: true,
    meta: {
      category: category || null,
      tags: tags.tags,
      scheduleKind: form.schedule === "none" ? null : form.schedule,
      recurrenceMonths: months,
      requiresQuizPass: form.requiresQuizPass,
    },
  };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function versionCounts(v: { lessonCount: number; blockCount: number; enrollmentCount: number }): string {
  return `${plural(v.lessonCount, "lesson")} · ${plural(v.blockCount, "block")} · ${v.enrollmentCount} enrolled`;
}
