"use client";

import type { DraftBlock } from "@/lib/schema/draft";
import Markdown from "@/components/Markdown";
import { CALLOUT_LABELS, CALLOUT_PALETTE, PACKAGE_STANDARDS, QUESTION_LABELS, isImageSource } from "./draft-helpers";

const EMPTY = <p className="text-sm italic text-gray-400">Empty. Edit this block to add content.</p>;

// Only http(s) and site paths become links: the schema's url() also accepts
// schemes such as javascript:.
function Address({ url }: { url: string }) {
  if (!isImageSource(url)) return <p className="break-all text-sm text-gray-700">{url}</p>;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="break-all text-sm underline" style={{ color: "var(--brand-primary)" }}>
      {url}
    </a>
  );
}

export default function BlockPreview({ block }: { block: DraftBlock }) {
  switch (block.kind) {
    case "text":
      return block.markdown.trim() ? <Markdown>{block.markdown}</Markdown> : EMPTY;
    case "callout":
      return (
        <div className={`rounded-md border-l-4 p-4 ${CALLOUT_PALETTE[block.variant]}`}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider opacity-70">{CALLOUT_LABELS[block.variant]}</p>
          {block.markdown.trim() ? (
            <Markdown className="prose prose-sm max-w-none prose-headings:text-current prose-strong:text-current">{block.markdown}</Markdown>
          ) : (
            EMPTY
          )}
        </div>
      );
    case "image":
      return (
        <div className="space-y-1 text-sm text-gray-700">
          <Address url={block.url} />
          <p>{block.alt ? `Description: ${block.alt}` : <span className="text-amber-700">No description for screen readers.</span>}</p>
          {block.caption ? <p className="text-gray-500">Caption: {block.caption}</p> : null}
        </div>
      );
    case "video":
      return (
        <div className="space-y-1 text-sm text-gray-700">
          <Address url={block.url} />
          <p className="text-gray-500">{block.transcript ? "Has a transcript." : "No transcript."}</p>
        </div>
      );
    case "embed":
      return (
        <div className="space-y-1 text-sm text-gray-700">
          <Address url={block.url} />
          <p className="text-gray-500">Provider: {block.provider}</p>
        </div>
      );
    case "quiz":
      return (
        <div className="text-sm text-gray-700">
          <p>
            {block.questions.length} question{block.questions.length === 1 ? "" : "s"} · pass at {block.passingScore}%
          </p>
          {block.questions.length > 0 ? (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-gray-600">
              {block.questions.map((q, i) => (
                <li key={i}>
                  {q.promptMd.trim() || <span className="italic text-gray-400">No wording yet</span>}{" "}
                  <span className="text-xs text-gray-400">({QUESTION_LABELS[q.kind]})</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      );
    case "roleplay":
      return (
        <div className="space-y-1 text-sm text-gray-700">
          <p>
            <span className="font-semibold">Persona:</span> {block.persona.trim() || <span className="italic text-gray-400">not set</span>}
          </p>
          <p className="line-clamp-3">
            <span className="font-semibold">Scenario:</span> {block.scenario.trim() || <span className="italic text-gray-400">not set</span>}
          </p>
        </div>
      );
    case "package":
      return (
        <div className="space-y-1 text-sm text-gray-700">
          <p className="font-semibold text-gray-900">{block.title}</p>
          <p className="text-gray-500">
            {PACKAGE_STANDARDS[block.standard]} package. It comes from an import and can&rsquo;t be edited here.
          </p>
        </div>
      );
  }
}
