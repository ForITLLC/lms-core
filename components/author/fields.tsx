"use client";

import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import Markdown from "@/components/Markdown";
import {
  failedField,
  numberText,
  numberTextError,
  parseNumberText,
  resyncField,
  sentField,
  syncedField,
  type Same,
  type SyncedField,
} from "./draft-helpers";

export const INPUT = "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 disabled:bg-gray-50";

export function useSyncedField<T>(server: T, same: Same<T> = Object.is) {
  const [field, setField] = useState<SyncedField<T>>(() => syncedField(server));
  useEffect(() => setField((f) => resyncField(f, server, same)), [server, same]);
  return {
    value: field.local,
    unsent: !same(field.local, field.sent),
    set: useCallback((local: T) => setField((f) => ({ ...f, local })), []),
    send: useCallback(() => setField(sentField), []),
    failed: useCallback(() => setField(failedField), []),
    revert: useCallback(() => setField((f) => syncedField(f.server)), []),
  };
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id} className="font-semibold text-gray-700">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="text-xs text-gray-500">{hint}</p> : null}
      {error ? <p className="text-xs text-rose-700">{error}</p> : null}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  maxLength,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <input
          id={id}
          type="text"
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT}
        />
      )}
    </Field>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  rows = 4,
  hint,
  maxLength,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  hint?: string;
  maxLength?: number;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <textarea
          id={id}
          rows={rows}
          value={value}
          maxLength={maxLength}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT}
        />
      )}
    </Field>
  );
}

// Holds the typed text so the box can be cleared and retyped. onChange gets
// what was typed, NaN for an empty required box, so the block can refuse it.
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  optional,
  hint,
  disabled,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  min: number;
  max: number;
  optional?: boolean;
  hint?: string;
  disabled?: boolean;
}) {
  const allowEmpty = optional === true;
  const [text, setText] = useState(numberText(value));
  useEffect(() => setText((t) => (Object.is(parseNumberText(t, allowEmpty), value) ? t : numberText(value))), [value, allowEmpty]);
  const error = disabled ? null : numberTextError(text, min, max, allowEmpty);
  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => (
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={text}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setText(e.target.value);
            onChange(parseNumberText(e.target.value, allowEmpty));
          }}
          className={`${INPUT} max-w-[8rem]`}
        />
      )}
    </Field>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)} className={INPUT}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2 text-sm">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-1" />
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="font-semibold text-gray-700">
          {label}
        </label>
        {hint ? <p className="text-xs text-gray-500">{hint}</p> : null}
      </div>
    </div>
  );
}

export function MarkdownField({
  label,
  value,
  onChange,
  rows = 10,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field label={label} hint="Markdown: **bold**, _italic_, # headings, - lists, [links](https://…).">
        {(id) => (
          <textarea
            id={id}
            rows={rows}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={`${INPUT} font-mono`}
          />
        )}
      </Field>
      <div className="flex flex-col gap-1 text-sm">
        <span className="font-semibold text-gray-700">Preview</span>
        <div className="min-h-[6rem] rounded-md border border-gray-200 bg-gray-50 p-3">
          {value.trim() ? <Markdown>{value}</Markdown> : <p className="text-gray-400">Nothing to preview yet.</p>}
        </div>
      </div>
    </div>
  );
}

export function IconButton({
  label,
  onClick,
  disabled,
  children,
  tone = "neutral",
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  tone?: "neutral" | "danger";
}) {
  const colors = tone === "danger" ? "text-rose-700 hover:bg-rose-50" : "text-gray-700 hover:bg-gray-50";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`rounded border border-gray-300 bg-white px-2 py-1 text-xs font-semibold ${colors} disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}
