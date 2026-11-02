import { test } from "node:test";
import assert from "node:assert/strict";
import type { IngestionStatusBody } from "./api";
import { describeSource, describeWarning, isFinished, progressLabel, progressPercent, sourceParts } from "./ingestion-helpers";

type Ingestion = IngestionStatusBody["ingestion"];

const job = (over: Partial<Ingestion> = {}): Ingestion => ({
  id: "abababab-0000-0000-0000-0000000000ab", status: "running", stage: "extract", lessonsDone: 0, lessonsTotal: null, attempts: 1,
  source: { kind: "youtube", ref: "https://youtu.be/x" }, warnings: [], courseId: null, error: null, retryAt: null,
  createdAt: "2026-10-29T12:00:00.000Z", updatedAt: "2026-10-29T12:00:00.000Z", ...over,
});

test("a source is named by kind; only a web address becomes a link, and pasted text never does", () => {
  assert.deepEqual(sourceParts({ kind: "youtube", ref: "https://youtu.be/x" }), { lead: "the YouTube video", ref: "https://youtu.be/x", href: "https://youtu.be/x" });
  assert.deepEqual(sourceParts({ kind: "url", ref: "https://aviation.example/wake" }), { lead: "the web page", ref: "https://aviation.example/wake", href: "https://aviation.example/wake" });
  assert.deepEqual(sourceParts({ kind: "text", ref: "https://looks.like/a-link" }), { lead: "pasted text", ref: "“https://looks.like/a-link”", href: null });
  assert.deepEqual(sourceParts({ kind: "url", ref: "javascript:alert(1)" }).href, null);
  assert.deepEqual(sourceParts({ kind: "pdf", ref: "manual.pdf" }), { lead: "a pdf source", ref: "manual.pdf", href: null });
  assert.equal(describeSource({ kind: "text", ref: "Hangar notes" }), "pasted text “Hangar notes”");
  assert.equal(describeWarning({ lesson: 2, position: 3, kind: "image", reason: "url: Enter a web address" }), "Lesson 2, block 3 (image): url: Enter a web address");
});

test("a job is finished once completed, failed or cancelled, and only then does the page stop polling", () => {
  assert.deepEqual(
    (["queued", "running", "completed", "failed", "cancelled"] as const).map(isFinished),
    [false, false, true, true, true],
  );
});

test("the progress label and bar follow the job's stage and lessons", () => {
  const time = (iso: string) => `at:${iso}`;
  const label = (over: Partial<Ingestion>) => progressLabel(job(over), time);
  assert.equal(label({ status: "queued", stage: null }), "Waiting to start.");
  assert.equal(label({ status: "queued", stage: "lessons" }), "Paused between steps; it carries on at the next run.");
  assert.equal(label({ status: "queued", stage: "outline", retryAt: "2026-10-29T12:05:00.000Z" }), "Waiting to try again at at:2026-10-29T12:05:00.000Z.");
  assert.equal(label({ stage: "extract" }), "Reading the source.");
  assert.equal(label({ stage: "outline" }), "Planning the lessons.");
  assert.equal(label({ stage: "lessons", lessonsDone: 2, lessonsTotal: 5 }), "Writing the lessons: 2 of 5 done.");
  assert.equal(label({ stage: "lessons" }), "Writing the lessons.");
  assert.equal(label({ stage: "saving" }), "Saving the draft.");
  assert.equal(label({ status: "completed", stage: "saving" }), "Your draft is ready.");
  assert.equal(label({ status: "failed" }), "The draft couldn't be made.");
  assert.equal(label({ status: "cancelled" }), "This draft was cancelled.");

  const bar = (over: Partial<Ingestion>) => progressPercent(job(over));
  assert.deepEqual(
    [bar({ stage: null }), bar({ stage: "extract" }), bar({ stage: "outline" }), bar({ stage: "lessons" }),
      bar({ stage: "lessons", lessonsDone: 0, lessonsTotal: 4 }), bar({ stage: "lessons", lessonsDone: 2, lessonsTotal: 4 }),
      bar({ stage: "lessons", lessonsDone: 9, lessonsTotal: 4 }), bar({ stage: "saving" }), bar({ status: "completed", stage: "saving" })],
    [5, 5, 10, 20, 20, 55, 90, 95, 100],
  );
});
