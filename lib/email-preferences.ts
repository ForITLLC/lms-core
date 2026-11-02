// State for the email on/off switches (components/EmailPreferences.tsx), kept
// pure so the flip, rollback and in-flight rules are testable without a DOM.

export interface EmailPreferenceCategory {
  key: string;
  label: string;
  description?: string;
  on: boolean;
}

export interface EmailPreferencesState {
  // What each switch shows; optimistic while its save is in flight.
  on: Readonly<Record<string, boolean>>;
  pending: readonly string[];
  // The key whose last change failed.
  error: string | null;
}

export type EmailPreferencesAction =
  | { type: "sync"; categories: readonly EmailPreferenceCategory[] }
  | { type: "start"; key: string; on: boolean }
  | { type: "saved"; key: string }
  | { type: "failed"; key: string; on: boolean };

export function initialEmailPreferences(categories: readonly EmailPreferenceCategory[]): EmailPreferencesState {
  const on: Record<string, boolean> = {};
  for (const category of categories) on[category.key] = category.on;
  return { on, pending: [], error: null };
}

export function emailPreferencesReducer(state: EmailPreferencesState, action: EmailPreferencesAction): EmailPreferencesState {
  switch (action.type) {
    case "sync": {
      // New values from the server, except for a switch whose save is in flight.
      const on: Record<string, boolean> = {};
      let changed = Object.keys(state.on).length !== action.categories.length;
      for (const category of action.categories) {
        const value = state.pending.includes(category.key) ? (state.on[category.key] ?? category.on) : category.on;
        on[category.key] = value;
        if (state.on[category.key] !== value) changed = true;
      }
      const error = state.error !== null && action.categories.some((c) => c.key === state.error) ? state.error : null;
      return changed || error !== state.error ? { ...state, on, error } : state;
    }
    case "start":
      return {
        on: { ...state.on, [action.key]: action.on },
        pending: state.pending.includes(action.key) ? state.pending : [...state.pending, action.key],
        error: state.error === action.key ? null : state.error,
      };
    case "saved":
      return { ...state, pending: state.pending.filter((key) => key !== action.key) };
    case "failed":
      return {
        on: { ...state.on, [action.key]: action.on },
        pending: state.pending.filter((key) => key !== action.key),
        error: action.key,
      };
  }
}

// One press: flip, save, then keep or roll back. `inFlight` is the synchronous
// guard, because React state lags a fast second press; a throw from onChange
// counts as a failure.
export async function toggleEmailPreference(
  key: string,
  on: boolean,
  onChange: (key: string, on: boolean) => Promise<void>,
  dispatch: (action: EmailPreferencesAction) => void,
  inFlight: Set<string>,
): Promise<"saved" | "failed" | "busy"> {
  if (inFlight.has(key)) return "busy";
  inFlight.add(key);
  dispatch({ type: "start", key, on });
  try {
    await onChange(key, on);
    dispatch({ type: "saved", key });
    return "saved";
  } catch {
    dispatch({ type: "failed", key, on: !on });
    return "failed";
  } finally {
    inFlight.delete(key);
  }
}
