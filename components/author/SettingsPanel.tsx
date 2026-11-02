"use client";

import { useEffect, useId, useState } from "react";
import type { DraftOp } from "@/lib/builder/draft-ops";
import { META_LIMITS, type DraftMeta } from "@/lib/schema/draft";
import Button from "@/components/Button";
import {
  addTags,
  removeTag,
  sameJson,
  SCHEDULE_HINTS,
  SCHEDULE_OPTIONS,
  scheduleChoice,
  settingsPatch,
  type ScheduleChoice,
} from "./draft-helpers";
import { CheckboxField, IconButton, INPUT, NumberField, SelectField, TextField, useSyncedField } from "./fields";

export default function SettingsPanel({
  meta,
  locked,
  edit,
  onDirtyChange,
}: {
  meta: DraftMeta;
  locked: boolean;
  edit: (ops: DraftOp[]) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const tagInputId = useId();
  const category = useSyncedField(meta.category ?? "");
  const tags = useSyncedField<string[]>(meta.tags, sameJson);
  const schedule = useSyncedField<ScheduleChoice>(scheduleChoice(meta.scheduleKind));
  const months = useSyncedField<number | null>(meta.recurrenceMonths);
  const quizPass = useSyncedField(meta.requiresQuizPass);
  const [pendingTag, setPendingTag] = useState("");
  const fields = [category, tags, schedule, months, quizPass];

  const recurring = schedule.value === "recurring";
  const dirty =
    category.unsent || tags.unsent || schedule.unsent || (recurring && months.unsent) || quizPass.unsent || pendingTag.trim() !== "";
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const patch = settingsPatch({
    category: category.value,
    tags: tags.value,
    schedule: schedule.value,
    recurrenceMonths: months.value,
    requiresQuizPass: quizPass.value,
    pendingTag,
  });
  const tagAdd = addTags(tags.value, pendingTag);
  const tagsFull = tags.value.length >= META_LIMITS.tags;

  function addPendingTag() {
    if (!tagAdd.ok || !pendingTag.trim()) return;
    tags.set(tagAdd.tags);
    setPendingTag("");
  }

  async function save() {
    if (!dirty || locked || !patch.ok) return;
    tags.set(patch.meta.tags);
    setPendingTag("");
    for (const field of fields) field.send();
    if (!(await edit([{ op: "setMeta", meta: patch.meta }]))) for (const field of fields) field.failed();
  }

  function undo() {
    for (const field of fields) field.revert();
    setPendingTag("");
  }

  return (
    <form
      className="rounded-xl border border-gray-200 bg-white p-4 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Settings</h2>
        <p className="text-xs text-gray-500">
          These take effect when you publish, for every learner, including those still on an earlier version.
        </p>
      </div>
      <TextField
        label="Category"
        value={category.value}
        maxLength={META_LIMITS.category}
        hint="Course lists group courses by this."
        disabled={locked}
        onChange={category.set}
      />

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={tagInputId} className="font-semibold text-gray-700">
          Tags <span className="font-normal text-gray-500">({tags.value.length} of {META_LIMITS.tags})</span>
        </label>
        {tags.value.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {tags.value.map((tag, i) => (
              <li key={`${i}:${tag}`} className="flex items-center gap-1 rounded-full border border-gray-300 bg-gray-50 py-0.5 pl-3 pr-1 text-xs text-gray-800">
                {tag}
                <button
                  type="button"
                  aria-label={`Remove the tag ${tag}`}
                  title={`Remove the tag ${tag}`}
                  disabled={locked}
                  onClick={() => tags.set(removeTag(tags.value, tag))}
                  className="rounded-full px-1 text-gray-500 hover:bg-gray-200 disabled:opacity-40"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex gap-2">
          <input
            id={tagInputId}
            type="text"
            value={pendingTag}
            placeholder={tagsFull ? "No more tags" : "Add a tag"}
            disabled={locked || tagsFull}
            aria-invalid={tagAdd.ok ? undefined : true}
            onChange={(e) => setPendingTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              addPendingTag();
            }}
            className={INPUT}
          />
          <IconButton label="Add the tag" disabled={locked || !tagAdd.ok || !pendingTag.trim()} onClick={addPendingTag}>
            Add
          </IconButton>
        </div>
        {tagAdd.ok ? <p className="text-xs text-gray-500">Press Enter to add. Separate several with commas.</p> : <p className="text-xs text-rose-700">{tagAdd.error}</p>}
      </div>

      <SelectField
        label="Renewal"
        value={schedule.value}
        options={SCHEDULE_OPTIONS}
        hint={SCHEDULE_HINTS[schedule.value]}
        disabled={locked}
        onChange={schedule.set}
      />
      <NumberField
        label="Months between renewals"
        value={months.value}
        min={1}
        max={META_LIMITS.recurrenceMonths}
        optional
        disabled={locked || !recurring}
        hint={recurring && months.value === null ? "A recurring course can't be published until this is set." : undefined}
        onChange={months.set}
      />
      <CheckboxField
        label="Learners must pass every quiz to finish"
        hint="Otherwise submitting each quiz is enough."
        checked={quizPass.value}
        disabled={locked}
        onChange={quizPass.set}
      />

      <div className="flex items-center gap-3">
        <Button size="sm" type="submit" disabled={!dirty || locked || !patch.ok}>
          Save settings
        </Button>
        {dirty ? (
          <button type="button" className="text-sm text-gray-600 hover:underline" onClick={undo}>
            Undo
          </button>
        ) : null}
      </div>
    </form>
  );
}
