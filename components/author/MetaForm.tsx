"use client";

import { useEffect } from "react";
import type { DraftOp } from "@/lib/builder/draft-ops";
import type { DraftMeta } from "@/lib/schema/draft";
import Button from "@/components/Button";
import { TextAreaField, TextField, useSyncedField } from "./fields";

export default function MetaForm({
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
  const title = useSyncedField(meta.title);
  const description = useSyncedField(meta.description);
  const dirty = title.unsent || description.unsent;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  async function save() {
    if (!dirty) return;
    title.send();
    description.send();
    if (!(await edit([{ op: "setMeta", meta: { title: title.value, description: description.value } }]))) {
      title.failed();
      description.failed();
    }
  }

  return (
    <form
      className="rounded-xl border border-gray-200 bg-white p-4 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Course details</h2>
      <TextField label="Title" value={title.value} maxLength={256} disabled={locked} onChange={title.set} />
      <TextAreaField
        label="Description"
        rows={4}
        maxLength={8000}
        hint="A short summary of what the course covers."
        value={description.value}
        disabled={locked}
        onChange={description.set}
      />
      <div className="flex items-center gap-3">
        <Button size="sm" type="submit" disabled={!dirty || locked}>
          Save details
        </Button>
        {dirty ? (
          <button
            type="button"
            className="text-sm text-gray-600 hover:underline"
            onClick={() => {
              title.revert();
              description.revert();
            }}
          >
            Undo
          </button>
        ) : null}
      </div>
    </form>
  );
}
