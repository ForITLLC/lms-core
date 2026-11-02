import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, new URL("../", import.meta.url)), "utf8");

test("the web player never reads an answer key or rubric", () => {
  const player = read("components/CoursePlayer.tsx");
  for (const field of ["correctChoiceId", "correctChoiceIds", "correctValue", "rubricMd"]) {
    assert.ok(!player.includes(field), `CoursePlayer.tsx mentions ${field}`);
  }
});

test("the learn page strips every block before handing lessons to the player", () => {
  const page = read("app/learn/[slug]/page.tsx");
  assert.match(page, /blocks: l\.blocks\.map\(stripBlock\)/);
  assert.match(page, /<CoursePlayer[\s\S]*lessons=\{lessons\}/);
  assert.ok(!page.includes("lessons={detail.lessons}"));
});
