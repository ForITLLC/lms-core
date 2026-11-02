"use client";

import { useState } from "react";
import { formatDueDay } from "@/lib/due-day";
import Button from "@/components/Button";

export interface AssignmentRow {
  AssignmentId: string;
  LearnerEmail: string;
  LearnerName: string;
  CourseSlug: string;
  CourseTitle: string;
  VersionNumber: number;
  AssignedBy: string;
  AssignedAt: string;
  DueDate: string | null;
  Note: string | null;
  Status: string;
}

export interface CoursePickerOption {
  slug: string;
  title: string;
  currentVersionNumber: number | null;
}

export interface LearnerPickerOption {
  email: string;
  displayName: string;
}

interface Props {
  initialAssignments: AssignmentRow[];
  learners: LearnerPickerOption[];
  courses: CoursePickerOption[];
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

export default function AssignmentEditor({
  initialAssignments,
  learners,
  courses,
}: Props) {
  const [rows, setRows] = useState<AssignmentRow[]>(initialAssignments);
  const [learnerEmail, setLearnerEmail] = useState(learners[0]?.email ?? "");
  const [courseSlug, setCourseSlug] = useState(courses[0]?.slug ?? "");
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!learnerEmail || !courseSlug) {
      setError("Pick a learner and a course.");
      return;
    }
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const body: Record<string, unknown> = { learnerEmail, courseSlug };
      if (dueDate) body.dueDate = new Date(dueDate).toISOString();
      if (note.trim()) body.note = note.trim();
      const res = await fetch("/api/admin/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as
        | { assignment: { assignmentId: string; created: boolean } }
        | { error: string };
      if (!res.ok || "error" in data) {
        throw new Error("error" in data ? data.error : `Failed (${res.status})`);
      }
      setOkMsg(data.assignment.created ? "Assigned." : "Updated existing assignment.");
      const refreshed = await fetch(
        `/api/admin/assignments?learnerEmail=${encodeURIComponent(learnerEmail)}`,
      );
      const list = (await refreshed.json()) as { assignments: AssignmentRow[] };
      // Merge in any rows for other learners that were already in `rows` so
      // the table isn't blown away on each submit.
      const otherLearnerRows = rows.filter((r) => r.LearnerEmail !== learnerEmail);
      setRows([...otherLearnerRows, ...list.assignments]);
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Assignment failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(assignmentId: string) {
    if (!confirm("Remove this assignment?")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/assignments/${assignmentId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      setRows((rs) => rs.filter((r) => r.AssignmentId !== assignmentId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  const groupedRows = new Map<string, AssignmentRow[]>();
  for (const r of rows) {
    const arr = groupedRows.get(r.LearnerEmail) ?? [];
    arr.push(r);
    groupedRows.set(r.LearnerEmail, arr);
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={submit}
        className="rounded-lg border border-gray-200 bg-white p-4 space-y-3"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="flex flex-col text-sm">
            <span className="font-semibold text-gray-700 mb-1">Learner</span>
            <select
              value={learnerEmail}
              onChange={(e) => setLearnerEmail(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-2"
              disabled={busy}
            >
              {learners.length === 0 ? (
                <option value="">No learners in tenant</option>
              ) : (
                learners.map((l) => (
                  <option key={l.email} value={l.email}>
                    {l.displayName} ({l.email})
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="flex flex-col text-sm">
            <span className="font-semibold text-gray-700 mb-1">Course</span>
            <select
              value={courseSlug}
              onChange={(e) => setCourseSlug(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-2"
              disabled={busy}
            >
              {courses.length === 0 ? (
                <option value="">No published courses</option>
              ) : (
                courses.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.title}
                    {c.currentVersionNumber
                      ? ` (v${c.currentVersionNumber})`
                      : ""}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="flex flex-col text-sm">
            <span className="font-semibold text-gray-700 mb-1">Due date (optional)</span>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-2"
              disabled={busy}
            />
          </label>

          <label className="flex flex-col text-sm">
            <span className="font-semibold text-gray-700 mb-1">Note (optional)</span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1024}
              placeholder="e.g. Onboarding follow-up"
              className="rounded-md border border-gray-300 px-3 py-2"
              disabled={busy}
            />
          </label>
        </div>

        <div className="flex items-center gap-3">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !learnerEmail || !courseSlug}
          >
            {busy ? "Saving…" : "Assign course"}
          </Button>
          {okMsg ? <span className="text-sm text-emerald-700">{okMsg}</span> : null}
          {error ? <span className="text-sm text-rose-600">{error}</span> : null}
        </div>
      </form>

      <div className="space-y-4">
        {rows.length === 0 ? (
          <p className="text-sm text-gray-600">
            No manual assignments yet. Pick a learner + course above.
          </p>
        ) : (
          Array.from(groupedRows.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([email, learnerRows]) => (
              <div key={email} className="rounded-lg border border-gray-200 bg-white">
                <div className="px-4 py-2 border-b border-gray-200 bg-gray-50">
                  <p className="font-semibold text-sm text-gray-800">
                    {learnerRows[0]?.LearnerName} · {email}
                  </p>
                </div>
                <ul className="divide-y divide-gray-100">
                  {learnerRows.map((r) => (
                    <li
                      key={r.AssignmentId}
                      className="px-4 py-3 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {r.CourseTitle}{" "}
                          <span className="text-xs text-gray-500">
                            v{r.VersionNumber}
                          </span>
                        </p>
                        <p className="text-xs text-gray-500">
                          Assigned by {r.AssignedBy} on {formatDate(r.AssignedAt)}
                          {r.DueDate ? ` · due ${formatDueDay(r.DueDate)}` : ""}
                          {r.Note ? ` · ${r.Note}` : ""}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        disabled={busy}
                        onClick={() => remove(r.AssignmentId)}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
