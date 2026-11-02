"use client";

import { useState } from "react";
import Button from "@/components/Button";
import {
  BLOCK_LABELS,
  blankBlock,
  guessProvider,
  isImageSource,
  isWebUrl,
  newKey,
  type BlankKind,
  type EditableBlock,
} from "./draft-helpers";
import { IconButton, TextField } from "./fields";

type UrlKind = "image" | "video" | "embed";

const BLANK_KINDS: BlankKind[] = ["text", "callout", "quiz", "roleplay"];
const URL_KINDS: UrlKind[] = ["image", "video", "embed"];

function addLabel(kind: BlankKind | UrlKind): string {
  const name = BLOCK_LABELS[kind].toLowerCase();
  return `Add ${/^[aeiou]/.test(name) ? "an" : "a"} ${name} block`;
}

function urlBlock(kind: UrlKind, url: string): EditableBlock {
  const key = newKey();
  if (kind === "image") return { kind, key, url, alt: "" };
  if (kind === "video") return { kind, key, url };
  return { kind, key, url, provider: guessProvider(url) };
}

// Image, video and embed blocks can't be saved without an address, so the
// menu asks for it before adding them.
export default function AddBlockMenu({
  disabled,
  limitReason,
  onAdd,
}: {
  disabled: boolean;
  limitReason: string | null;
  onAdd: (block: EditableBlock) => Promise<boolean>;
}) {
  const [urlKind, setUrlKind] = useState<UrlKind | null>(null);
  const [url, setUrl] = useState("");
  const blocked = disabled || limitReason !== null;

  const valid = urlKind === "image" ? isImageSource(url.trim()) : isWebUrl(url.trim());

  async function addUrlBlock() {
    if (!urlKind || !valid) return;
    if (await onAdd(urlBlock(urlKind, url.trim()))) {
      setUrlKind(null);
      setUrl("");
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-gray-300 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Add</span>
        {BLANK_KINDS.map((kind) => (
          <IconButton key={kind} label={addLabel(kind)} disabled={blocked} onClick={() => void onAdd(blankBlock(kind))}>
            + {BLOCK_LABELS[kind]}
          </IconButton>
        ))}
        {URL_KINDS.map((kind) => (
          <IconButton key={kind} label={addLabel(kind)} disabled={blocked} onClick={() => setUrlKind(kind)}>
            + {BLOCK_LABELS[kind]}
          </IconButton>
        ))}
      </div>
      {limitReason ? <p className="mt-2 text-xs text-gray-600">{limitReason}</p> : null}
      {urlKind ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void addUrlBlock();
          }}
        >
          <TextField
            label={`${BLOCK_LABELS[urlKind]} address`}
            value={url}
            placeholder={urlKind === "image" ? "https://… or /images/…" : "https://…"}
            hint={url.trim() && !valid ? "That isn't a full web address yet." : undefined}
            onChange={setUrl}
          />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={blocked || !valid}>
              Add {BLOCK_LABELS[urlKind].toLowerCase()}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setUrlKind(null);
                setUrl("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
