import { z } from "zod";

// What an AI authoring job reads to write a course (docs/plans/2026-10-29-ai-authoring.md,
// slice A3): a YouTube video's captions, pasted text or a public web page, all
// as one extract. The prompts name the kind in the corpus header, and only a
// video source is embedded in lesson 1.

export const SOURCE_KINDS = ["youtube", "text", "url"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export function isSourceKind(kind: string): kind is SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(kind);
}

// The most text a source may hold: a paste over it is refused, and so is a web
// page whose text runs over it. SourceRef holds at most this much.
export const SOURCE_TEXT_MAX = 200_000;
export const SOURCE_REF_MAX = 2048;
export const SOURCE_TITLE_MAX = 200;

const Base = {
  title: z.string(),
  author: z.string().nullable(),
  text: z.string(),
  approxMinutes: z.number(),
};

export const SourceExtract = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("youtube"),
    ...Base,
    url: z.string(),
    videoId: z.string(),
    thumbnailUrl: z.string(),
    transcriptSource: z.enum(["yt-dlp", "youtube-transcript"]),
  }),
  z.object({ kind: z.literal("text"), ...Base, url: z.null() }),
  z.object({ kind: z.literal("url"), ...Base, url: z.string() }),
]);

export type SourceExtract = z.infer<typeof SourceExtract>;

// The source can't be used, and asking again won't change that: a blocked
// address, a page too large or of the wrong type, a paste over the cap. The
// job fails at once.
export class SourceRefusedError extends Error {}

// The source didn't answer this time (a timeout, a 5xx or 429 from the page);
// the job retries under its backoff.
export class SourceUnavailableError extends Error {
  readonly retryAfterMs: number | null;

  constructor(message: string, retryAfterMs: number | null = null) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

export function isVideo(extract: SourceExtract): boolean {
  return extract.kind === "youtube";
}

// What the prompts call the source's words.
export function material(extract: SourceExtract): string {
  return isVideo(extract) ? "transcript" : "text";
}

const BODY_LABEL: Record<SourceKind, string> = { youtube: "TRANSCRIPT", text: "TEXT", url: "PAGE TEXT" };

function sourceLine(extract: SourceExtract): string {
  switch (extract.kind) {
    case "youtube":
      return `Source: YouTube video "${extract.title}" by ${extract.author ?? "Unknown"}`;
    case "url":
      return `Source: web page "${extract.title}"${extract.author ? ` from ${extract.author}` : ""}`;
    case "text":
      return `Source: pasted text "${extract.title}"${extract.author ? ` by ${extract.author}` : ""}`;
  }
}

// The source corpus that goes in each prompt's cached system prompt. The
// quiz prompt leaves out the length.
export function sourceCorpus(extract: SourceExtract, withLength: boolean): string {
  const lines = [sourceLine(extract)];
  if (extract.url) lines.push(`URL: ${extract.url}`);
  if (withLength) {
    lines.push(isVideo(extract) ? `Duration: ~${extract.approxMinutes} minutes` : `Length: ~${extract.approxMinutes} minutes of reading`);
  }
  lines.push("", `${BODY_LABEL[extract.kind]}:`, extract.text);
  return lines.join("\n");
}

const READING_WORDS_PER_MINUTE = 200;

export function readingMinutes(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / READING_WORDS_PER_MINUTE));
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{1,64}$/;

// The video a YouTube address names, or null when it names none: watch,
// shorts, live and embed pages on youtube.com and its subdomains (m., music.),
// and youtu.be short links.
export function youTubeVideoId(address: string): string | null {
  let u: URL;
  try {
    u = new URL(address.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  let id: string | null | undefined = null;
  if (host === "youtu.be" || host === "www.youtu.be") {
    id = u.pathname.split("/")[1];
  } else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    const [, first, second] = u.pathname.split("/");
    if (first === "watch") id = u.searchParams.get("v");
    else if (first === "shorts" || first === "live" || first === "embed") id = second;
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}
