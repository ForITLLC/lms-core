"use client";

import { useState } from "react";

// v1 owner picker: person-or-none. The owner route also accepts a group owner
// (kind: "group"), but the brief's primary case is the owning instructor, so
// the picker UI stays a people select — YAGNI on a group browser.

export interface OwnerCandidate {
  appUserId: string;
  displayName: string;
  email: string;
}

interface Props {
  courseId: string;
  currentOwnerUserId: string | null;
  currentOwnerName: string | null;
  currentOwnerGroupId: string | null;
  currentOwnerGroupName: string | null;
  users: OwnerCandidate[];
}

type SaveState = "idle" | "saving" | "saved" | "error";

export default function CourseOwnerPicker({
  courseId,
  currentOwnerUserId,
  currentOwnerName,
  currentOwnerGroupId,
  currentOwnerGroupName,
  users,
}: Props) {
  const [selected, setSelected] = useState<string>(currentOwnerUserId ?? "");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  // A group-owned course can't be represented by the people select. Surface
  // the current group so the picker doesn't silently look "unowned".
  const groupOwned = currentOwnerGroupId !== null;

  async function save(userId: string) {
    setState("saving");
    setError(null);
    const body =
      userId === ""
        ? { kind: "none" as const }
        : { kind: "user" as const, userId };
    try {
      const res = await fetch(
        `/api/admin/courses/${encodeURIComponent(courseId)}/owner`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setState("saved");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Could not save owner");
    }
  }

  return (
    <div>
      {groupOwned && (
        <p className="mb-3 text-sm text-gray-600">
          Currently owned by group{" "}
          <span className="font-medium text-gray-800">
            {currentOwnerGroupName}
          </span>
          . Choosing a person below reassigns it.
        </p>
      )}

      <label className="block text-sm font-medium text-gray-700 mb-1">
        Owning instructor
      </label>
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={selected}
          disabled={state === "saving"}
          onChange={(e) => {
            const next = e.target.value;
            setSelected(next);
            void save(next);
          }}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm bg-white min-w-[16rem] disabled:opacity-60"
        >
          <option value="">No owner</option>
          {users.map((u) => (
            <option key={u.appUserId} value={u.appUserId}>
              {u.displayName} ({u.email})
            </option>
          ))}
        </select>

        {state === "saving" && (
          <span className="text-sm text-gray-500">Saving…</span>
        )}
        {state === "saved" && (
          <span className="text-sm" style={{ color: "var(--brand-accent)" }}>
            Saved
          </span>
        )}
      </div>

      {state === "error" && error && (
        <p className="mt-2 rounded bg-red-50 border border-red-200 p-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {!groupOwned && state === "idle" && currentOwnerName && (
        <p className="mt-2 text-xs text-gray-500">
          Current owner: {currentOwnerName}
        </p>
      )}
    </div>
  );
}
