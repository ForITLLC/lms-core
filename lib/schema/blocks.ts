import { z } from "zod";
import { isImageSource, isWebUrl } from "./url";

export const webUrl = () => z.string().refine(isWebUrl, "Enter a web address starting with https://.");
export const imageSource = () =>
  z.string().refine(isImageSource, "Enter a web address starting with https://, or a path on this site starting with /.");

export const TextBlock = z.object({
  kind: z.literal("text"),
  markdown: z.string(),
});

export const ImageBlock = z.object({
  kind: z.literal("image"),
  // A root-relative path under /public resolves against the current host, so
  // it works across every tenant subdomain without rewriting.
  url: imageSource(),
  alt: z.string().default(""),
  caption: z.string().optional(),
});

export const VideoBlock = z.object({
  kind: z.literal("video"),
  url: webUrl(),
  transcript: z.string().optional(),
});

export const EmbedBlock = z.object({
  kind: z.literal("embed"),
  url: webUrl(),
  provider: z.enum(["youtube", "vimeo", "loom", "other"]),
});

export const CalloutBlock = z.object({
  kind: z.literal("callout"),
  variant: z.enum(["info", "warning", "success", "tip"]),
  markdown: z.string(),
});

export const QuizBlock = z.object({
  kind: z.literal("quiz"),
  quizId: z.string().uuid(),
});

export const RoleplayBlock = z.object({
  kind: z.literal("roleplay"),
  persona: z.string(),
  scenario: z.string(),
  rubricMd: z.string(),
});

// A launchable of an imported SCORM or cmi5 package. Launch URLs and tokens
// are minted at play time, never stored, because this payload reaches the
// iPhone app and the marketplace preview.
export const PackageBlock = z.object({
  kind: z.literal("package"),
  launchableId: z.string().uuid(),
  title: z.string(),
  standard: z.enum(["scorm12", "scorm2004", "cmi5"]),
});

export const Block = z.discriminatedUnion("kind", [
  TextBlock,
  ImageBlock,
  VideoBlock,
  EmbedBlock,
  CalloutBlock,
  QuizBlock,
  RoleplayBlock,
  PackageBlock,
]);

export type Block = z.infer<typeof Block>;
export type BlockKind = Block["kind"];
