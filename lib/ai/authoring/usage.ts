// The model tokens an AI authoring job spends, per model, summed across all of
// its attempts and kept in lms.AssetIngestion.UsageJson (migration 0031).

export interface CallUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export interface ModelUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export type Usage = { [model: string]: ModelUsage };

// The usage block of a Messages API response.
export interface ApiUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

const FIELDS = ["calls", "inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"] as const;

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

export function callUsage(model: string, usage: ApiUsage | null | undefined): CallUsage {
  return {
    model,
    inputTokens: count(usage?.input_tokens),
    outputTokens: count(usage?.output_tokens),
    cacheWriteTokens: count(usage?.cache_creation_input_tokens),
    cacheReadTokens: count(usage?.cache_read_input_tokens),
  };
}

export function addUsage(total: Usage, call: CallUsage): Usage {
  const prior = total[call.model] ?? { calls: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  return {
    ...total,
    [call.model]: {
      calls: prior.calls + 1,
      inputTokens: prior.inputTokens + call.inputTokens,
      outputTokens: prior.outputTokens + call.outputTokens,
      cacheWriteTokens: prior.cacheWriteTokens + call.cacheWriteTokens,
      cacheReadTokens: prior.cacheReadTokens + call.cacheReadTokens,
    },
  };
}

// NULL, or anything that isn't a usage object, reads as none.
export function readUsage(json: string | null | undefined): Usage {
  if (!json) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>);
  const readable = entries.every(([, entry]) =>
    entry !== null && typeof entry === "object"
    && FIELDS.every((field) => {
      const value = (entry as Record<string, unknown>)[field];
      return typeof value === "number" && Number.isFinite(value) && value >= 0;
    }));
  if (!readable) return {};
  return Object.fromEntries(entries.map(([model, entry]) => {
    const e = entry as ModelUsage;
    return [model, { calls: e.calls, inputTokens: e.inputTokens, outputTokens: e.outputTokens, cacheWriteTokens: e.cacheWriteTokens, cacheReadTokens: e.cacheReadTokens }];
  }));
}

// Tokens in counts every input token the models read, cached or not; the
// cached transcript is most of a run.
export function tokenTotals(usage: Usage): { tokensIn: number; tokensOut: number } {
  let tokensIn = 0;
  let tokensOut = 0;
  for (const model of Object.values(usage)) {
    tokensIn += model.inputTokens + model.cacheWriteTokens + model.cacheReadTokens;
    tokensOut += model.outputTokens;
  }
  return { tokensIn, tokensOut };
}

// A model call that answered with output the job can't use (max_tokens, no
// tool call, a schema refusal) still spent its tokens; they ride on the error.
export class ModelOutputError extends Error {
  readonly usage: CallUsage;

  constructor(message: string, usage: CallUsage) {
    super(message);
    this.usage = usage;
  }
}
