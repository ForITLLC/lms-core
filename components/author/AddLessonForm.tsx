"use client";

import { useState } from "react";
import Button from "@/components/Button";
import type { DraftLesson } from "@/lib/schema/draft";
import { newLesson } from "./draft-helpers";
import { INPUT } from "./fields";

export default function AddLessonForm({
  disabled,
  limitReason,
  onAdd,
}: {
  disabled: boolean;
  limitReason: string | null;
  onAdd: (lesson: DraftLesson) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");

  if (limitReason) return <p className="rounded-xl border border-dashed border-gray-300 bg-white p-4 text-sm text-gray-600">{limitReason}</p>;

  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-dashed border-gray-300 bg-white p-4 sm:flex-row sm:items-center"
      onSubmit={async (e) => {
        e.preventDefault();
        const trimmed = title.trim();
        if (trimmed && (await onAdd(newLesson(trimmed)))) setTitle("");
      }}
    >
      <label className="sr-only" htmlFor="new-lesson-title">
        New lesson title
      </label>
      <input
        id="new-lesson-title"
        type="text"
        value={title}
        maxLength={256}
        placeholder="New lesson title"
        onChange={(e) => setTitle(e.target.value)}
        className={INPUT}
      />
      <Button type="submit" size="sm" disabled={disabled || !title.trim()}>
        Add lesson
      </Button>
    </form>
  );
}
