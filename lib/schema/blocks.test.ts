import { test } from "node:test";
import assert from "node:assert/strict";
import { Block } from "./blocks";
import { DraftBlock } from "./draft";
import { isImageSource, isWebUrl } from "./url";
import { STARTER_COURSES } from "@/db/seed/starter-library";

// Block addresses land in an href, an img src or an iframe src on the learner
// page, so anything but http(s) (or a site path, for an image) is refused.

const HOSTILE = [
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "JAVASCRIPT:alert(1)",
  "  javascript:alert(1)",
  "\tjavascript:alert(1)",
  "java\tscript:alert(1)",
  "javascript://youtube.com/embed/%0aalert(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
  "vbscript:msgbox(1)",
  "VBScript:msgbox(1)",
  "//evil.com",
  "//evil.com/x.png",
  "/\\evil.com",
  "  https://example.com/x",
  "file:///etc/passwd",
  "ftp://example.com/x",
  "https:evil.com",
  "",
];

const block = (kind: "image" | "video" | "embed", url: string) =>
  kind === "embed" ? { kind, url, provider: "other" } : kind === "image" ? { kind, url, alt: "" } : { kind, url };

test("video, embed and image refuse javascript:, data:, vbscript: (any case, leading whitespace) and //host", () => {
  for (const kind of ["image", "video", "embed"] as const) {
    for (const url of HOSTILE) {
      assert.equal(Block.safeParse(block(kind, url)).success, false, `${kind} accepted ${JSON.stringify(url)}`);
      assert.equal(DraftBlock.safeParse({ ...block(kind, url), key: "b1" }).success, false, `draft ${kind} accepted ${JSON.stringify(url)}`);
    }
  }
});

test("https:// and http:// pass for every kind; a /path on this site passes for an image only", () => {
  for (const kind of ["image", "video", "embed"] as const) {
    for (const url of ["https://www.youtube.com/watch?v=abc", "http://example.com/x.mp4", "HTTPS://Example.com/a"]) {
      assert.equal(Block.safeParse(block(kind, url)).success, true, `${kind} refused ${url}`);
    }
  }
  for (const url of ["/media/x.png", "/images/courses/categories/security.svg"]) {
    assert.equal(Block.safeParse(block("image", url)).success, true, url);
    assert.equal(Block.safeParse(block("video", url)).success, false, url);
    assert.equal(Block.safeParse(block("embed", url)).success, false, url);
  }
});

test("the predicates the learner player uses agree with the schema", () => {
  for (const url of HOSTILE) {
    assert.equal(isWebUrl(url), false, url);
    assert.equal(isImageSource(url), false, url);
  }
  assert.equal(isWebUrl("https://example.com"), true);
  assert.equal(isWebUrl("/media/x.png"), false);
  assert.equal(isImageSource("/media/x.png"), true);
  assert.equal(isWebUrl(undefined), false);
});

test("every starter-library block still parses, so seeding is unaffected", () => {
  let checked = 0;
  for (const course of STARTER_COURSES) {
    for (const lesson of course.lessons) {
      for (const b of lesson.blocks) {
        const parsed = Block.safeParse(b);
        assert.equal(parsed.success, true, `${course.slug}: ${JSON.stringify(b).slice(0, 120)}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 100, `only ${checked} blocks checked`);
});
