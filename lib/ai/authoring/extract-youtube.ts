import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeTranscript } from "youtube-transcript";
import { SourceRefusedError, youTubeVideoId, type SourceExtract } from "./source";

export type YouTubeExtract = Extract<SourceExtract, { kind: "youtube" }>;

function parseVideoId(url: string): string {
  const id = youTubeVideoId(url);
  if (!id) throw new SourceRefusedError(`Unrecognized YouTube URL: ${url}`);
  return id;
}

async function fetchOEmbed(url: string): Promise<{ title: string; author: string; thumbnailUrl: string }> {
  const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
  if (!res.ok) throw new Error(`oEmbed failed: ${res.status} ${res.statusText}`);
  const j = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
  return {
    title: j.title ?? "Untitled",
    author: j.author_name ?? "Unknown",
    thumbnailUrl: j.thumbnail_url ?? "",
  };
}

function runYtDlp(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

interface Json3Event {
  segs?: Array<{ utf8?: string }>;
  tStartMs?: number;
  dDurationMs?: number;
}

interface Json3Transcript {
  events?: Json3Event[];
}

function parseJson3(text: string): { transcript: string; lastEndSec: number } {
  const j: Json3Transcript = JSON.parse(text);
  const parts: string[] = [];
  let lastEndSec = 0;
  for (const ev of j.events ?? []) {
    if (!ev.segs) continue;
    const line = ev.segs.map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (line) parts.push(line);
    const end = Math.round(((ev.tStartMs ?? 0) + (ev.dDurationMs ?? 0)) / 1000);
    if (end > lastEndSec) lastEndSec = end;
  }
  return { transcript: parts.join(" "), lastEndSec };
}

async function extractViaYtDlp(videoId: string): Promise<{ transcript: string; durationApproxSec: number } | null> {
  const dir = await mkdtemp(join(tmpdir(), "lms-ingest-"));
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const tryArgs = [
      ["--write-subs", "--sub-langs", "en.*,en", "--skip-download", "--sub-format", "json3", "-o", `${dir}/sub.%(ext)s`, url],
      ["--write-auto-subs", "--sub-langs", "en.*,en", "--skip-download", "--sub-format", "json3", "-o", `${dir}/sub.%(ext)s`, url],
    ];
    for (const args of tryArgs) {
      const res = await runYtDlp(args);
      if (res.code !== 0 && !/no subtitles/i.test(res.stderr)) {
        continue;
      }
      const files = (await readdir(dir)).filter((f) => f.endsWith(".json3"));
      if (files.length === 0) continue;
      const text = await readFile(join(dir, files[0]!), "utf8");
      const parsed = parseJson3(text);
      if (parsed.transcript.length > 0) {
        return { transcript: parsed.transcript, durationApproxSec: parsed.lastEndSec };
      }
    }
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function extractViaNpm(videoId: string): Promise<{ transcript: string; durationApproxSec: number } | null> {
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: "en" }).catch(() =>
      YoutubeTranscript.fetchTranscript(videoId),
    );
    if (!segments || segments.length === 0) return null;
    const transcript = segments.map((s) => s.text.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
    const last = segments[segments.length - 1]!;
    return { transcript, durationApproxSec: Math.round((last.offset + last.duration) / 1000) };
  } catch {
    return null;
  }
}

export async function extractYouTube(url: string): Promise<YouTubeExtract> {
  const videoId = parseVideoId(url);
  const canonical = `https://www.youtube.com/watch?v=${videoId}`;

  const meta = await fetchOEmbed(canonical);

  let transcriptResult = await extractViaYtDlp(videoId);
  let source: YouTubeExtract["transcriptSource"] = "yt-dlp";

  if (!transcriptResult) {
    transcriptResult = await extractViaNpm(videoId);
    source = "youtube-transcript";
  }

  if (!transcriptResult) {
    throw new Error(
      `No captions available for video ${videoId}. Neither yt-dlp nor youtube-transcript could fetch a transcript. The video likely has captions disabled by the creator and no auto-captions generated. To author from this video, an audio-to-text step (e.g., Whisper) is required.`,
    );
  }

  return {
    kind: "youtube",
    title: meta.title,
    author: meta.author,
    url: canonical,
    text: transcriptResult.transcript,
    approxMinutes: Math.round(transcriptResult.durationApproxSec / 60),
    videoId,
    thumbnailUrl: meta.thumbnailUrl,
    transcriptSource: source,
  };
}
