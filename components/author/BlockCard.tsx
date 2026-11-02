"use client";

import { useEffect, useState } from "react";
import type { DraftBlock } from "@/lib/schema/draft";
import Button from "@/components/Button";
import BlockFields from "./BlockFields";
import BlockPreview from "./BlockPreview";
import { BLOCK_LABELS, blockSaveError, removeBlockPrompt, sameJson, type EditableBlock } from "./draft-helpers";
import { IconButton, useSyncedField } from "./fields";

const HOLD_MOVE = "Save or cancel this block's changes before moving it";

export interface BlockMoves {
  up: (() => void) | null;
  down: (() => void) | null;
  upLabel: string;
  downLabel: string;
}

export default function BlockCard({
  block,
  position,
  moves,
  busy,
  locked,
  editing,
  onEditingChange,
  setDirty,
  onSave,
  onRemove,
}: {
  block: DraftBlock;
  position: number;
  moves: BlockMoves;
  busy: boolean;
  locked: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  setDirty: (blockKey: string, dirty: boolean) => void;
  onSave: (block: EditableBlock) => Promise<boolean>;
  onRemove: () => void;
}) {
  const field = useSyncedField<DraftBlock>(block, sameJson);
  const local = field.value;
  const [problem, setProblem] = useState<string | null>(null);

  const editable = block.kind !== "package";
  const dirty = editing && field.unsent;
  const blockKey = block.key;
  useEffect(() => {
    setDirty(blockKey, dirty);
    return () => setDirty(blockKey, false);
  }, [blockKey, dirty, setDirty]);

  async function save() {
    if (local.kind === "package") return;
    const error = blockSaveError(local);
    setProblem(error);
    if (error) return;
    field.send();
    if (await onSave(local)) onEditingChange(false);
    else field.failed();
  }

  function cancel() {
    field.revert();
    setProblem(null);
    onEditingChange(false);
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {position}. {BLOCK_LABELS[block.kind]}
          {dirty ? <span className="ml-2 normal-case tracking-normal text-amber-700">Unsaved changes</span> : null}
        </span>
        <div className="flex flex-wrap gap-1">
          <IconButton label={dirty ? HOLD_MOVE : moves.upLabel} disabled={!moves.up || busy || locked || dirty} onClick={() => moves.up?.()}>
            ↑
          </IconButton>
          <IconButton label={dirty ? HOLD_MOVE : moves.downLabel} disabled={!moves.down || busy || locked || dirty} onClick={() => moves.down?.()}>
            ↓
          </IconButton>
          {editable ? (
            <IconButton label={editing ? "Close the editor" : "Edit this block"} disabled={locked} onClick={() => (editing ? cancel() : onEditingChange(true))}>
              {editing ? "Close" : "Edit"}
            </IconButton>
          ) : null}
          <IconButton
            label="Remove this block"
            tone="danger"
            disabled={busy || locked}
            onClick={() => {
              if (confirm(removeBlockPrompt(block))) onRemove();
            }}
          >
            Remove
          </IconButton>
        </div>
      </div>
      <div className="p-3">
        {editing && local.kind !== "package" ? (
          <div className="space-y-3">
            <BlockFields value={local} onChange={field.set} />
            {problem ? <p className="text-sm text-rose-700">{problem}</p> : null}
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void save()} disabled={!dirty || busy || locked}>
                Save block
              </Button>
              <Button size="sm" variant="outline" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <BlockPreview block={block} />
        )}
      </div>
    </div>
  );
}
