import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const claudeSkillPath = resolve(
  root,
  "skills",
  "claude-code",
  "skills",
  "creatorcut",
  "SKILL.md",
);
const openClawSkillPath = resolve(
  root,
  "skills",
  "openclaw-creatorcut",
  "SKILL.md",
);

test("Claude Code and OpenClaw Skills preserve the public workflow boundary", async () => {
  const [claudeSkill, openClawSkill] = await Promise.all([
    readFile(claudeSkillPath, "utf8"),
    readFile(openClawSkillPath, "utf8"),
  ]);
  for (const skill of [claudeSkill, openClawSkill]) {
    assert.match(skill, /^---\nname: creatorcut\n/u);
    assert.match(skill, /creatorcut director context inspect/u);
    assert.match(skill, /creatorcut cards get/u);
    assert.match(skill, /creatorcut cards submit/u);
    assert.match(skill, /data\.answer_set_id/u);
    assert.match(skill, /presentation_digest/u);
    assert.match(skill, /creatorcut director status/u);
    assert.match(skill, /creatorcut edit status/u);
    assert.match(skill, /creatorcut export status/u);
    assert.match(skill, /requires_user_action/u);
    assert.doesNotMatch(skill, /creatorcut-server/u);
    assert.doesNotMatch(skill, /DirectorPolicy/u);
    assert.doesNotMatch(skill, /service[_ -]?token/iu);
    assert.doesNotMatch(skill, /private[_ -]?key/iu);
    assert.doesNotMatch(skill, /\/Users\//u);
  }
  assert.match(claudeSkill, /AskUserQuestion/u);
  assert.match(openClawSkill, /semantic text presentation/u);
  assert.doesNotMatch(openClawSkill, /AskUserQuestion/u);
});
