"use client";

import { useId, type KeyboardEvent } from "react";
import type { DraftOp } from "@/lib/builder/draft-ops";
import type { DraftLesson } from "@/lib/schema/draft";
import AddBlockMenu from "./AddBlockMenu";
import BlockCard, { type BlockMoves } from "./BlockCard";
import { blockLimit, numberText } from "./draft-helpers";
import { IconButton, INPUT, useSyncedField } from "./fields";

export interface Neighbour {
  key: string;
  blockCount: number;
}

export default function LessonCard({
  lesson,
  index,
  lessonCount,
  previous,
  next,
  busy,
  locked,
  isOpen,
  setOpen,
  setDirty,
  edit,
}: {
  lesson: DraftLesson;
  index: number;
  lessonCount: number;
  previous: Neighbour | null;
  next: Neighbour | null;
  busy: boolean;
  locked: boolean;
  isOpen: (blockKey: string) => boolean;
  setOpen: (blockKey: string, open: boolean) => void;
  setDirty: (blockKey: string, dirty: boolean) => void;
  edit: (ops: DraftOp[]) => Promise<boolean>;
}) {
  const lessonKey = lesson.key;
  const last = lesson.blocks.length - 1;
  const frozen = busy || locked;
  const previousFull = previous !== null && blockLimit(previous.blockCount) !== null;
  const nextFull = next !== null && blockLimit(next.blockCount) !== null;

  // At either end of a lesson, up and down carry the block into the
  // neighbouring lesson, so a block can reach any lesson one step at a time.
  function movesFor(blockKey: string, at: number): BlockMoves {
    const move = (to: number, toLessonKey?: string) => () =>
      void edit([{ op: "moveBlock", lessonKey, blockKey, to, ...(toLessonKey ? { toLessonKey } : {}) }]);
    return {
      up: at > 0 ? move(at - 1) : previous && !previousFull ? move(previous.blockCount, previous.key) : null,
      down: at < last ? move(at + 1) : next && !nextFull ? move(0, next.key) : null,
      upLabel: at > 0 ? "Move block up" : previousFull ? "The previous lesson is full" : "Move block to the end of the previous lesson",
      downLabel: at < last ? "Move block down" : nextFull ? "The next lesson is full" : "Move block to the start of the next lesson",
    };
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <LessonHeader lesson={lesson} index={index} disabled={locked} edit={edit} />
        <div className="flex gap-1">
          <IconButton label="Move lesson up" disabled={index === 0 || frozen} onClick={() => void edit([{ op: "moveLesson", lessonKey, to: index - 1 }])}>
            ↑
          </IconButton>
          <IconButton
            label="Move lesson down"
            disabled={index === lessonCount - 1 || frozen}
            onClick={() => void edit([{ op: "moveLesson", lessonKey, to: index + 1 }])}
          >
            ↓
          </IconButton>
          <IconButton
            label="Remove this lesson"
            tone="danger"
            disabled={frozen}
            onClick={() => {
              const what = lesson.blocks.length ? ` and its ${lesson.blocks.length} block${lesson.blocks.length === 1 ? "" : "s"}` : "";
              if (confirm(`Remove lesson ${index + 1}${what}?`)) void edit([{ op: "removeLesson", lessonKey }]);
            }}
          >
            Remove
          </IconButton>
        </div>
      </div>

      {lesson.blocks.length === 0 ? <p className="text-sm text-gray-500">This lesson has no content yet.</p> : null}
      <div className="space-y-3">
        {lesson.blocks.map((block, at) => (
          <BlockCard
            key={block.key}
            block={block}
            position={at + 1}
            moves={movesFor(block.key, at)}
            busy={busy}
            locked={locked}
            editing={isOpen(block.key)}
            onEditingChange={(open) => setOpen(block.key, open)}
            setDirty={setDirty}
            onSave={(updated) => edit([{ op: "updateBlock", lessonKey, block: updated }])}
            onRemove={() => void edit([{ op: "removeBlock", lessonKey, blockKey: block.key }])}
          />
        ))}
      </div>
      <AddBlockMenu
        disabled={frozen}
        limitReason={blockLimit(lesson.blocks.length)}
        onAdd={async (block) => {
          const added = await edit([{ op: "addBlock", lessonKey, block }]);
          if (added) setOpen(block.key, true);
          return added;
        }}
      />
    </section>
  );
}

// Title and minutes save when the field loses focus, one edit per change. They
// stay editable while a save is in flight; useSyncedField keeps what is typed
// meanwhile from being replaced by the reply.
function LessonHeader({
  lesson,
  index,
  disabled,
  edit,
}: {
  lesson: DraftLesson;
  index: number;
  disabled: boolean;
  edit: (ops: DraftOp[]) => Promise<boolean>;
}) {
  const titleId = useId();
  const minutesId = useId();
  const title = useSyncedField(lesson.title);
  const minutes = useSyncedField(numberText(lesson.estMinutes));

  async function saveTitle() {
    if (!title.unsent) return;
    title.send();
    if (!(await edit([{ op: "updateLesson", lessonKey: lesson.key, title: title.value }]))) title.failed();
  }

  async function saveMinutes() {
    if (!minutes.unsent) return;
    const trimmed = minutes.value.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && !(Number.isInteger(parsed) && parsed >= 1 && parsed <= 600)) {
      minutes.revert();
      return;
    }
    minutes.send();
    if (!(await edit([{ op: "updateLesson", lessonKey: lesson.key, estMinutes: parsed }]))) minutes.failed();
  }

  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-end gap-3">
      <div className="flex min-w-[12rem] flex-1 flex-col gap-1 text-sm">
        <label htmlFor={titleId} className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Lesson {index + 1}
        </label>
        <input
          id={titleId}
          type="text"
          value={title.value}
          maxLength={256}
          placeholder="Lesson title"
          disabled={disabled}
          onChange={(e) => title.set(e.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={onEnter}
          className={`${INPUT} font-semibold`}
        />
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={minutesId} className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Minutes
        </label>
        <input
          id={minutesId}
          type="number"
          inputMode="numeric"
          min={1}
          max={600}
          value={minutes.value}
          disabled={disabled}
          onChange={(e) => minutes.set(e.target.value)}
          onBlur={() => void saveMinutes()}
          onKeyDown={onEnter}
          className={`${INPUT} w-24`}
        />
      </div>
    </div>
  );
}
