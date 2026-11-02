import type { IngestionSourceBody, IngestionStatusBody, IngestionWarningBody } from "./api";

type Ingestion = IngestionStatusBody["ingestion"];

// Where an AI draft came from, as the course editor shows it.
export interface AiOrigin {
  source: IngestionSourceBody;
  warnings: IngestionWarningBody[];
}

// The ref is a web address only for the kinds that were checked as one
// before the job was queued, so only those become links.
export function sourceParts(source: IngestionSourceBody): { lead: string; ref: string; href: string | null } {
  const href = /^https?:\/\//i.test(source.ref) ? source.ref : null;
  if (source.kind === "youtube") return { lead: "the YouTube video", ref: source.ref, href };
  if (source.kind === "url") return { lead: "the web page", ref: source.ref, href };
  if (source.kind === "text") return { lead: "pasted text", ref: `“${source.ref}”`, href: null };
  return { lead: `a ${source.kind} source`, ref: source.ref, href: null };
}

export function describeSource(source: IngestionSourceBody): string {
  const { lead, ref } = sourceParts(source);
  return `${lead} ${ref}`;
}

export function describeWarning(warning: IngestionWarningBody): string {
  return `Lesson ${warning.lesson}, block ${warning.position} (${warning.kind}): ${warning.reason}`;
}

export function isFinished(status: Ingestion["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function progressLabel(ingestion: Ingestion, time: (iso: string) => string = (iso) => new Date(iso).toLocaleTimeString()): string {
  switch (ingestion.status) {
    case "completed":
      return "Your draft is ready.";
    case "failed":
      return "The draft couldn't be made.";
    case "cancelled":
      return "This draft was cancelled.";
    case "queued":
      if (ingestion.retryAt) return `Waiting to try again at ${time(ingestion.retryAt)}.`;
      return ingestion.stage ? "Paused between steps; it carries on at the next run." : "Waiting to start.";
  }
  switch (ingestion.stage) {
    case "outline":
      return "Planning the lessons.";
    case "lessons":
      return ingestion.lessonsTotal
        ? `Writing the lessons: ${ingestion.lessonsDone} of ${ingestion.lessonsTotal} done.`
        : "Writing the lessons.";
    case "saving":
      return "Saving the draft.";
    default:
      return "Reading the source.";
  }
}

// A rough share of the work done, for the bar: the lessons are most of it.
export function progressPercent(ingestion: Ingestion): number {
  if (ingestion.status === "completed") return 100;
  if (ingestion.stage === "saving") return 95;
  if (ingestion.stage === "lessons" && ingestion.lessonsTotal) {
    return Math.round(20 + (70 * Math.min(ingestion.lessonsDone, ingestion.lessonsTotal)) / ingestion.lessonsTotal);
  }
  if (ingestion.stage === "lessons") return 20;
  if (ingestion.stage === "outline") return 10;
  return 5;
}
