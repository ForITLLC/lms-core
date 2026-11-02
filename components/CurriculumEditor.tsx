"use client";

import { useState } from "react";

export type Membership = "excluded" | "optional" | "mandatory";

export interface EditorCourse {
  courseId: string;
  title: string;
  status: string;
  category: string | null;
  membership: Membership;
  orderIndex: number;
}

const MEMBERSHIPS: { value: Membership; label: string }[] = [
  { value: "excluded", label: "Not in curriculum" },
  { value: "optional", label: "Optional" },
  { value: "mandatory", label: "Mandatory" },
];

// Admin curriculum editor. Each course row writes through to
// /api/admin/curriculum on change — there is no separate "save" step, so the
// default curriculum always reflects what is on screen.
export default function CurriculumEditor({
  initial,
}: {
  initial: EditorCourse[];
}) {
  const [courses, setCourses] = useState<EditorCourse[]>(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function persist(
    courseId: string,
    membership: Membership,
    orderIndex: number,
  ) {
    setBusyId(courseId);
    setError(null);
    const prev = courses;
    setCourses((cs) =>
      cs.map((c) =>
        c.courseId === courseId ? { ...c, membership, orderIndex } : c,
      ),
    );
    try {
      const res = await fetch("/api/admin/curriculum", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId, membership, orderIndex }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
    } catch (e) {
      setCourses(prev);
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p className="text-sm text-rose-600">{error}</p>
      ) : null}
      {courses.map((course) => (
        <div
          key={course.courseId}
          className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 md:flex-row md:items-center md:justify-between"
        >
          <div className="min-w-0">
            <p className="font-semibold text-gray-900 truncate">{course.title}</p>
            <p className="text-xs text-gray-500">
              {course.status}
              {course.category ? ` · ${course.category}` : ""}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex rounded-md border border-gray-300 overflow-hidden">
              {MEMBERSHIPS.map((m) => {
                const active = course.membership === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    disabled={busyId === course.courseId}
                    onClick={() =>
                      persist(course.courseId, m.value, course.orderIndex)
                    }
                    className={`px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                      active
                        ? "text-white"
                        : "bg-white text-gray-600 hover:bg-gray-50"
                    }`}
                    style={active ? { backgroundColor: "var(--brand-primary)" } : undefined}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>

            {course.membership !== "excluded" ? (
              <label className="flex items-center gap-1 text-xs text-gray-500">
                Order
                <input
                  type="number"
                  defaultValue={course.orderIndex}
                  disabled={busyId === course.courseId}
                  onBlur={(e) => {
                    const next = Number.parseInt(e.target.value, 10) || 0;
                    if (next !== course.orderIndex) {
                      persist(course.courseId, course.membership, next);
                    }
                  }}
                  className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                />
              </label>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
