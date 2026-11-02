"use client";

import { useState } from "react";

// Publish-to-catalogue toggle, rendered only for the canonical `forit` tenant
// (the page gates this with isForitTenant). Flipping it PUTs to the course
// catalogue route, which re-verifies the ForIT-tenant constraint server-side.

interface Props {
  courseId: string;
  initialIsCatalog: boolean;
}

type SaveState = "idle" | "saving" | "saved" | "error";

export default function CatalogPublishToggle({
  courseId,
  initialIsCatalog,
}: Props) {
  const [isCatalog, setIsCatalog] = useState(initialIsCatalog);
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setState("saving");
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/courses/${encodeURIComponent(courseId)}/catalogue`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isCatalog: next }),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setIsCatalog(next);
      setState("saved");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Could not save");
    }
  }

  return (
    <div>
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={isCatalog}
          disabled={state === "saving"}
          onChange={(e) => void toggle(e.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm font-medium text-gray-800">
          Publish to the shared catalogue
        </span>
        {state === "saving" && (
          <span className="text-sm text-gray-500">Saving…</span>
        )}
        {state === "saved" && (
          <span className="text-sm" style={{ color: "var(--brand-accent)" }}>
            Saved
          </span>
        )}
      </label>
      <p className="mt-1 text-xs text-gray-500">
        When on, any tenant can subscribe to this course from their catalogue.
        Subscribed learners see it read-only.
      </p>
      {state === "error" && error && (
        <p className="mt-2 rounded bg-red-50 border border-red-200 p-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
