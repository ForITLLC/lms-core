import type { DraftDoc, PublishProblem } from "@/lib/schema/draft";

// The author UI reaches the database only through /api/author/*.

export type ApiResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; error: string; code: string | null; body: Record<string, unknown> };

export async function callApi<T>(url: string, method: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: "Couldn't reach the server. Check your connection and try again.", code: null, body: {} };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, status: res.status, body: data as T };
  const error =
    res.status === 401
      ? "You're signed out. Sign in again in another tab, then retry."
      : typeof data.error === "string"
        ? data.error
        : `Request failed (${res.status})`;
  return { ok: false, status: res.status, error, code: typeof data.code === "string" ? data.code : null, body: data };
}

export interface DraftRecordBody {
  draft: {
    draftId: string;
    courseId: string;
    slug: string;
    status: string;
    baseVersionId: string | null;
    revision: number;
    doc: DraftDoc;
    updatedAt: string;
    updatedBy: string;
  };
  problems: PublishProblem[];
}

export interface DraftEditBody {
  draftId: string;
  revision: number;
  doc: DraftDoc;
  problems: PublishProblem[];
}

export interface PublishBody {
  versionId: string;
  versionNumber: number;
}

export interface VersionSummaryBody {
  versionId: string;
  versionNumber: number;
  publishedAt: string;
  publishedBy: string;
  changeNote: string | null;
  isCurrent: boolean;
  lessonCount: number;
  blockCount: number;
  enrollmentCount: number;
}

export interface VersionHistoryBody {
  currentVersionId: string | null;
  versions: VersionSummaryBody[];
}

export interface CreatedCourseBody {
  courseId: string;
  slug: string;
}

export const draftUrl = (courseId: string) => `/api/author/courses/${encodeURIComponent(courseId)}/draft`;
export const publishUrl = (courseId: string) => `/api/author/courses/${encodeURIComponent(courseId)}/publish`;
export const versionsUrl = (courseId: string) => `/api/author/courses/${encodeURIComponent(courseId)}/versions`;

export function problemsIn(body: Record<string, unknown>): PublishProblem[] | null {
  const list = body.problems;
  if (!Array.isArray(list)) return null;
  return list.filter(
    (p): p is PublishProblem =>
      typeof p === "object" && p !== null && typeof (p as PublishProblem).where === "string" && typeof (p as PublishProblem).problem === "string",
  );
}

// POST /api/author/ingestions and GET /api/author/ingestions/[id] (AI authoring, slice A4).
export interface QueuedIngestionBody {
  ingestionId: string;
}

export interface IngestionWarningBody {
  lesson: number;
  position: number;
  kind: string;
  reason: string;
}

export interface IngestionSourceBody {
  kind: string;
  ref: string;
}

export interface IngestionStatusBody {
  ingestion: {
    id: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    stage: "extract" | "outline" | "lessons" | "saving" | null;
    lessonsDone: number;
    lessonsTotal: number | null;
    attempts: number;
    source: IngestionSourceBody;
    warnings: IngestionWarningBody[];
    courseId: string | null;
    error: string | null;
    retryAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
}

export const INGESTIONS_URL = "/api/author/ingestions";
export const ingestionUrl = (ingestionId: string) => `${INGESTIONS_URL}/${encodeURIComponent(ingestionId)}`;
