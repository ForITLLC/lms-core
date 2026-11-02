"use client";

import { useState } from "react";
import Button from "@/components/Button";

// Subscriber-side catalogue browser. Lists every published ForIT catalogue
// course; each row has a Subscribe / Unsubscribe button that hits
// /api/admin/catalogue. Subscribed courses then surface read-only in /learn.

export interface CatalogueCourse {
  courseId: string;
  title: string;
  slug: string;
  description: string | null;
  category: string | null;
  lessonCount: number;
  isSubscribed: boolean;
}

interface Props {
  initialCourses: CatalogueCourse[];
}

export default function CatalogueManager({ initialCourses }: Props) {
  const [courses, setCourses] = useState<CatalogueCourse[]>(initialCourses);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setSubscription(course: CatalogueCourse, subscribe: boolean) {
    setBusyId(course.courseId);
    setError(null);
    try {
      const res = subscribe
        ? await fetch("/api/admin/catalogue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ courseId: course.courseId }),
          })
        : await fetch(
            `/api/admin/catalogue?courseId=${encodeURIComponent(course.courseId)}`,
            { method: "DELETE" },
          );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setCourses((prev) =>
        prev.map((c) =>
          c.courseId === course.courseId
            ? { ...c, isSubscribed: subscribe }
            : c,
        ),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not update subscription",
      );
    } finally {
      setBusyId(null);
    }
  }

  if (courses.length === 0) {
    return (
      <p className="text-gray-600 text-center py-4">
        The shared catalogue has no published courses yet.
      </p>
    );
  }

  return (
    <div>
      {error && (
        <p className="mb-4 rounded bg-red-50 border border-red-200 p-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <ul className="space-y-3">
        {courses.map((c) => (
          <li
            key={c.courseId}
            className="rounded-md border border-gray-200 p-4 flex items-start justify-between gap-4"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className="font-semibold"
                  style={{ color: "var(--brand-primary)" }}
                >
                  {c.title}
                </span>
                {c.category && (
                  <span className="inline-block px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 text-xs">
                    {c.category}
                  </span>
                )}
                <span className="text-xs text-gray-500">
                  {c.lessonCount} lesson{c.lessonCount === 1 ? "" : "s"}
                </span>
              </div>
              {c.description && (
                <p className="mt-1 text-sm text-gray-600">{c.description}</p>
              )}
            </div>
            <div className="shrink-0">
              <Button
                onClick={() => void setSubscription(c, !c.isSubscribed)}
                disabled={busyId === c.courseId}
                variant={c.isSubscribed ? "outline" : "primary"}
              >
                {busyId === c.courseId
                  ? "Working…"
                  : c.isSubscribed
                    ? "Unsubscribe"
                    : "Subscribe"}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
