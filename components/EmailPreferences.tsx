"use client";

// One on/off switch per kind of email. The "on" track is the tenant's
// --brand-primary-on-white, then --brand-primary, then a neutral grey.
import * as React from "react";
import {
  emailPreferencesReducer,
  initialEmailPreferences,
  toggleEmailPreference,
  type EmailPreferenceCategory,
} from "@/lib/email-preferences";

const DEFAULT_ERROR = "That change was not saved. Try again.";

const LIST_CLASS = "divide-y divide-black/10 [.dark_&]:divide-white/15 [[data-theme=dark]_&]:divide-white/15";
const ROW_CLASS = "flex items-start justify-between gap-4 py-3";
const LABEL_CLASS = "block text-sm font-medium cursor-pointer text-neutral-900 [.dark_&]:text-white [[data-theme=dark]_&]:text-white";
const DESCRIPTION_CLASS = "mt-0.5 text-sm text-neutral-500 [.dark_&]:text-neutral-400 [[data-theme=dark]_&]:text-neutral-400";
const ERROR_CLASS = "mt-1 text-sm text-red-700 [.dark_&]:text-red-400 [[data-theme=dark]_&]:text-red-400";
const SWITCH_CLASS =
  "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
  "focus-visible:ring-[var(--brand-primary-on-white,var(--brand-primary,theme(colors.neutral.700)))] " +
  "focus-visible:ring-offset-white [.dark_&]:focus-visible:ring-offset-black [[data-theme=dark]_&]:focus-visible:ring-offset-black";
const SWITCH_ON_CLASS =
  "bg-[var(--brand-primary-on-white,var(--brand-primary,theme(colors.neutral.700)))] " +
  "[.dark_&]:border-white/30 [[data-theme=dark]_&]:border-white/30";
const SWITCH_OFF_CLASS = "bg-neutral-300 [.dark_&]:bg-neutral-600 [[data-theme=dark]_&]:bg-neutral-600";
const KNOB_CLASS = "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform";

export function EmailPreferences({
  categories,
  onChange,
  errorMessage = DEFAULT_ERROR,
}: {
  categories: readonly EmailPreferenceCategory[];
  onChange: (key: string, on: boolean) => Promise<void>;
  errorMessage?: string;
}) {
  const [state, dispatch] = React.useReducer(emailPreferencesReducer, categories, initialEmailPreferences);
  const inFlight = React.useRef(new Set<string>());
  const latest = React.useRef({ categories, onChange });
  latest.current = { categories, onChange };
  const idPrefix = React.useId().replace(/:/g, "");

  const signature = JSON.stringify(categories.map((c) => [c.key, c.on]));
  React.useEffect(() => {
    dispatch({ type: "sync", categories: latest.current.categories });
  }, [signature]);

  return (
    <ul className={LIST_CLASS} data-testid="email-preferences">
      {categories.map((category, index) => {
        const id = `${idPrefix}-email-${index}`;
        const descriptionId = category.description ? `${id}-description` : undefined;
        const errorId = state.error === category.key ? `${id}-error` : undefined;
        const on = state.on[category.key] ?? category.on;
        const pending = state.pending.includes(category.key);
        return (
          <li key={category.key} className={ROW_CLASS}>
            <div className="min-w-0">
              <label htmlFor={id} className={LABEL_CLASS}>
                {category.label}
              </label>
              {category.description ? (
                <p id={descriptionId} className={DESCRIPTION_CLASS}>
                  {category.description}
                </p>
              ) : null}
              {errorId ? (
                <p id={errorId} role="alert" className={ERROR_CLASS}>
                  {errorMessage}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              role="switch"
              id={id}
              aria-checked={on}
              aria-describedby={[descriptionId, errorId].filter(Boolean).join(" ") || undefined}
              aria-disabled={pending ? true : undefined}
              data-key={category.key}
              className={`${SWITCH_CLASS} ${on ? SWITCH_ON_CLASS : SWITCH_OFF_CLASS} ${pending ? "cursor-wait opacity-60" : "cursor-pointer"}`}
              onClick={() => {
                if (!pending) void toggleEmailPreference(category.key, !on, latest.current.onChange, dispatch, inFlight.current);
              }}
            >
              <span aria-hidden="true" className={`${KNOB_CLASS} ${on ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
