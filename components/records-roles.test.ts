import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RecordsRoles, { type RecordsRolesPerson } from "./RecordsRoles";

// The admin's roles list on /admin/records (card d3e16430): a learner, an
// instructor or a training manager gets a select of exactly those three
// roles; an admin's or an author's row is read-only; names are text.

(globalThis as { React?: typeof React }).React = React;

const PEOPLE: RecordsRolesPerson[] = [
  { appUserId: "a0000000-0000-4000-8000-000000000001", displayName: "Ada Admin", email: "admin@a.test", role: "admin" },
  { appUserId: "a0000000-0000-4000-8000-000000000002", displayName: "Al Author", email: "author@a.test", role: "author" },
  { appUserId: "a0000000-0000-4000-8000-000000000003", displayName: "Pat <b>Pilot</b>", email: "pilot@a.test", role: "learner" },
  { appUserId: "a0000000-0000-4000-8000-000000000004", displayName: "Cam Captain", email: "captain@a.test", role: "instructor" },
  { appUserId: "a0000000-0000-4000-8000-000000000005", displayName: "Mo Manager", email: "manager@a.test", role: "training_manager" },
];
const render = (people: RecordsRolesPerson[]) => renderToStaticMarkup(React.createElement(RecordsRoles, { people }));

test("a select for each learner, instructor and training manager, offering only those three roles; admins and authors read-only", () => {
  const html = render(PEOPLE);
  const selects = html.match(/<select[^>]*aria-label="Role for [^"]*"/g) ?? [];
  assert.deepEqual(selects.map((s) => /aria-label="Role for ([^"]*)"/.exec(s)![1]), ["Pat &lt;b&gt;Pilot&lt;/b&gt;", "Cam Captain", "Mo Manager"]);
  const options = [...new Set(html.match(/<option value="[^"]*"/g) ?? [])];
  assert.deepEqual(options, ['<option value="learner"', '<option value="instructor"', '<option value="training_manager"']);
  assert.equal(html.includes('value="admin"'), false);
  assert.equal(html.includes('value="author"'), false);
  assert.ok(html.includes("<span class=\"text-gray-700\">Admin</span>"), "known positive: the admin's row is text");
  assert.ok(html.includes("<span class=\"text-gray-700\">Author</span>"));
  assert.equal(html.includes("<b>Pilot</b>"), false, "a name is text, never markup");
});

test("each select shows the person's stored role", () => {
  const html = render(PEOPLE.slice(2));
  const selected = html.match(/<option value="[^"]*" selected=""/g) ?? [];
  assert.deepEqual(selected, ['<option value="learner" selected=""', '<option value="instructor" selected=""', '<option value="training_manager" selected=""']);
});
