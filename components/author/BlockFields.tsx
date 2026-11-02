"use client";

import { CALLOUT_LABELS, EMBED_PROVIDERS, guessProvider, type BlockOf, type EditableBlock } from "./draft-helpers";
import { MarkdownField, SelectField, TextAreaField, TextField } from "./fields";
import QuizFields from "./QuizFields";

const CALLOUT_OPTIONS = (Object.keys(CALLOUT_LABELS) as BlockOf<"callout">["variant"][]).map((value) => ({
  value,
  label: CALLOUT_LABELS[value],
}));

const PROVIDER_OPTIONS = EMBED_PROVIDERS.map((value) => ({
  value,
  label: value === "youtube" ? "YouTube" : value === "other" ? "Other" : value.charAt(0).toUpperCase() + value.slice(1),
}));

export default function BlockFields({ value, onChange }: { value: EditableBlock; onChange: (next: EditableBlock) => void }) {
  switch (value.kind) {
    case "text":
      return <MarkdownField label="Text" value={value.markdown} onChange={(markdown) => onChange({ ...value, markdown })} />;
    case "callout":
      return (
        <div className="space-y-3">
          <SelectField label="Style" value={value.variant} options={CALLOUT_OPTIONS} onChange={(variant) => onChange({ ...value, variant })} />
          <MarkdownField label="Text" rows={6} value={value.markdown} onChange={(markdown) => onChange({ ...value, markdown })} />
        </div>
      );
    case "image":
      return (
        <div className="space-y-3">
          <TextField label="Image address" value={value.url} placeholder="https://…" onChange={(url) => onChange({ ...value, url })} />
          <TextField
            label="Description for screen readers"
            value={value.alt}
            hint="Say what the image shows, for learners who can't see it."
            onChange={(alt) => onChange({ ...value, alt })}
          />
          <TextField
            label="Caption (optional)"
            value={value.caption ?? ""}
            onChange={(caption) => onChange({ ...value, caption: caption || undefined })}
          />
        </div>
      );
    case "video":
      return (
        <div className="space-y-3">
          <TextField label="Video address" value={value.url} placeholder="https://…" onChange={(url) => onChange({ ...value, url })} />
          <TextAreaField
            label="Transcript (optional)"
            rows={6}
            value={value.transcript ?? ""}
            onChange={(transcript) => onChange({ ...value, transcript: transcript || undefined })}
          />
        </div>
      );
    case "embed":
      return (
        <div className="space-y-3">
          <TextField
            label="Embed address"
            value={value.url}
            placeholder="https://…"
            onChange={(url) => onChange({ ...value, url, provider: guessProvider(url) })}
          />
          <SelectField label="Provider" value={value.provider} options={PROVIDER_OPTIONS} onChange={(provider) => onChange({ ...value, provider })} />
        </div>
      );
    case "roleplay":
      return (
        <div className="space-y-3">
          <TextAreaField label="Persona" rows={2} value={value.persona} hint="Who the learner is talking to." onChange={(persona) => onChange({ ...value, persona })} />
          <TextAreaField label="Scenario" rows={4} value={value.scenario} onChange={(scenario) => onChange({ ...value, scenario })} />
          <MarkdownField label="Marking rubric" rows={6} value={value.rubricMd} onChange={(rubricMd) => onChange({ ...value, rubricMd })} />
        </div>
      );
    case "quiz":
      return <QuizFields value={value} onChange={onChange} />;
  }
}
