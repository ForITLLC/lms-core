"use client";

import { useState } from "react";
import Button from "@/components/Button";
import { publishBlockReason } from "./draft-helpers";
import type { PublishOutcome } from "./useDraft";
import { TextAreaField } from "./fields";

export default function PublishPanel({
  neverPublished,
  hasProblems,
  dirty,
  locked,
  onPublish,
}: {
  neverPublished: boolean;
  hasProblems: boolean;
  dirty: boolean;
  locked: boolean;
  onPublish: (changeNote: string) => Promise<PublishOutcome>;
}) {
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const blocked = publishBlockReason({ locked, dirty });

  async function publish() {
    setPublishing(true);
    setMessage(null);
    const outcome = await onPublish(note);
    setPublishing(false);
    if (!outcome.ok) setMessage(outcome.message);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-700">
        {neverPublished
          ? "Learners can't see this course until it is published."
          : "Learners already enrolled stay on the version they started. New starts, assignments and renewals get the new version."}
      </p>
      <TextAreaField label="Change note (optional)" rows={2} maxLength={1024} value={note} onChange={setNote} />
      <Button onClick={() => void publish()} disabled={publishing || blocked !== null}>
        {publishing ? "Publishing…" : neverPublished ? "Publish" : "Publish new version"}
      </Button>
      {blocked ? <p className="text-xs font-semibold text-amber-800">{blocked}</p> : null}
      {hasProblems && !message && !blocked ? <p className="text-xs text-gray-500">Fix the problems listed below first.</p> : null}
      {message ? (
        <p role="alert" className="text-sm text-rose-700">
          {message}
        </p>
      ) : null}
    </div>
  );
}
