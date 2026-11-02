import Anthropic from "@anthropic-ai/sdk";

export const MODELS = {
  reasoning: "claude-opus-4-7",
  bulk: "claude-sonnet-4-6",
  fast: "claude-haiku-4-5",
} as const;

let client: Anthropic | null = null;

export function getClaude(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    client = new Anthropic({ apiKey });
  }
  return client;
}

export interface CachedSystemBlock {
  type: "text";
  text: string;
  cache_control: { type: "ephemeral" };
}

export function buildCachedSystem(text: string): CachedSystemBlock[] {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

// A model call worth trying again later: rate limited (429), overloaded (529)
// or another 5xx, a 408, or no answer at all (a dropped connection or a
// timeout). The SDK has already retried these twice by the time one reaches
// a caller. retryAfterMs is the server's own hint, when it sent one.
export function transientAiError(err: unknown): { retryAfterMs: number | null } | null {
  if (err instanceof Anthropic.APIConnectionError) return { retryAfterMs: null };
  if (!(err instanceof Anthropic.APIError)) return null;
  const status = err.status;
  if (status !== 408 && status !== 429 && !(typeof status === "number" && status >= 500)) return null;
  return { retryAfterMs: retryAfterMs(err.headers) };
}

function retryAfterMs(headers: Record<string, string | null | undefined> | undefined): number | null {
  const ms = Number(headers?.["retry-after-ms"]);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const seconds = Number(headers?.["retry-after"]);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return null;
}
