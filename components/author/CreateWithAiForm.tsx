"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/Button";
import { LESSON_COUNT_MAX, LESSON_COUNT_MIN } from "@/lib/ai/authoring/options";
import { SOURCE_REF_MAX, SOURCE_TEXT_MAX, SOURCE_TITLE_MAX } from "@/lib/ai/authoring/source";
import { callApi, INGESTIONS_URL, type QueuedIngestionBody } from "./api";
import { CheckboxField, SelectField, TextAreaField, TextField } from "./fields";

type Kind = "youtube" | "url" | "text";

const KINDS: { value: Kind; label: string }[] = [
  { value: "youtube", label: "A YouTube video" },
  { value: "url", label: "A web page" },
  { value: "text", label: "Text I paste in" },
];

const AUTO = "auto";
const LESSON_CHOICES = [
  { value: AUTO, label: "Let the AI choose" },
  ...Array.from({ length: LESSON_COUNT_MAX - LESSON_COUNT_MIN + 1 }, (_, i) => {
    const n = String(LESSON_COUNT_MIN + i);
    return { value: n, label: `${n} lessons` };
  }),
];

export default function CreateWithAiForm() {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("youtube");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [lessons, setLessons] = useState(AUTO);
  const [quizzes, setQuizzes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = kind === "text" ? title.trim() !== "" && text.trim() !== "" : url.trim() !== "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    const source = kind === "text" ? { kind, title, text } : { kind, url: url.trim() };
    const options = lessons === AUTO ? { quizzes } : { quizzes, lessonCount: Number(lessons) };
    const res = await callApi<QueuedIngestionBody>(INGESTIONS_URL, "POST", { source, options });
    if (res.ok) {
      router.push(`/author/ingestions/${encodeURIComponent(res.body.ingestionId)}`);
      return;
    }
    setBusy(false);
    setError(res.error);
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-4 rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-sm text-gray-700">
        The AI drafts a course from your source: lessons, and a quiz for each if you want one. It stays a draft. Review every
        lesson in the course editor before you publish it.
      </p>
      <SelectField label="Draft it from" value={kind} options={KINDS} onChange={setKind} disabled={busy} />
      {kind === "text" ? (
        <>
          <TextField label="Title" value={title} onChange={setTitle} maxLength={SOURCE_TITLE_MAX} disabled={busy} />
          <TextAreaField
            label="Text"
            value={text}
            onChange={setText}
            rows={12}
            maxLength={SOURCE_TEXT_MAX}
            hint={`Notes, a procedure, a manual chapter: plain text, up to ${SOURCE_TEXT_MAX.toLocaleString("en-US")} characters.`}
            disabled={busy}
          />
        </>
      ) : (
        <TextField
          label={kind === "youtube" ? "YouTube link" : "Web page link"}
          value={url}
          onChange={setUrl}
          maxLength={SOURCE_REF_MAX}
          placeholder={kind === "youtube" ? "https://www.youtube.com/watch?v=…" : "https://…"}
          hint={kind === "youtube" ? "The video needs captions." : "A public page. Pages behind a sign-in can't be read."}
          disabled={busy}
        />
      )}
      <SelectField label="Lessons" value={lessons} options={LESSON_CHOICES} onChange={setLessons} disabled={busy} />
      <CheckboxField label="Add a quiz to each lesson" checked={quizzes} onChange={setQuizzes} disabled={busy} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || !ready}>
          {busy ? "Starting…" : "Draft the course"}
        </Button>
        <span className="text-xs text-gray-500">It takes a few minutes. Nothing is published.</span>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-rose-700">
          {error}
        </p>
      ) : null}
    </form>
  );
}
