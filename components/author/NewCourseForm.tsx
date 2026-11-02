"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/Button";
import { callApi, type CreatedCourseBody } from "./api";
import { INPUT } from "./fields";

export default function NewCourseForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    const res = await callApi<CreatedCourseBody>("/api/author/courses", "POST", { title: trimmed });
    if (res.ok) {
      router.push(`/author/courses/${encodeURIComponent(res.body.courseId)}`);
      return;
    }
    setBusy(false);
    setError(res.error);
  }

  return (
    <form onSubmit={create} className="rounded-xl border border-gray-200 bg-white p-4 space-y-2">
      <label htmlFor="new-course-title" className="block text-sm font-semibold text-gray-700">
        Start a new course
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="new-course-title"
          type="text"
          value={title}
          maxLength={256}
          placeholder="Course title"
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          className={INPUT}
        />
        <Button type="submit" disabled={busy || !title.trim()}>
          {busy ? "Creating…" : "Create course"}
        </Button>
      </div>
      <p className="text-xs text-gray-500">It starts as a draft. Learners see nothing until you publish it.</p>
      {error ? (
        <p role="alert" className="text-sm text-rose-700">
          {error}
        </p>
      ) : null}
    </form>
  );
}
