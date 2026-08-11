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
const openClawReadmePath = resolve(
  root,
  "skills",
  "openclaw-creatorcut",
  "README.md",
);

test("Claude Code and OpenClaw Skills preserve the public workflow boundary", async () => {
  const [claudeSkill, openClawSkill, openClawReadme] = await Promise.all([
    readFile(claudeSkillPath, "utf8"),
    readFile(openClawSkillPath, "utf8"),
    readFile(openClawReadmePath, "utf8"),
  ]);
  for (const skill of [claudeSkill, openClawSkill]) {
    assert.match(skill, /^---\nname: creatorcut\n/u);
    assert.match(skill, /creatorcut director context inspect/u);
    assert.match(skill, /creatorcut cards get/u);
    assert.match(skill, /data\.answer_set_id/u);
    assert.match(skill, /presentation_digest/u);
    assert.match(skill, /creatorcut director status/u);
    assert.match(skill, /creatorcut edit status/u);
    assert.match(skill, /creatorcut export status/u);
    assert.match(skill, /requires_user_action/u);
    assert.match(skill, /next_suggested.*display-only/su);
    assert.doesNotMatch(skill, /creatorcut-server/u);
    assert.doesNotMatch(skill, /DirectorPolicy/u);
    assert.doesNotMatch(skill, /service[_ -]?token/iu);
    assert.doesNotMatch(skill, /private[_ -]?key/iu);
    assert.doesNotMatch(skill, /\/Users\//u);
  }
  assert.match(claudeSkill, /next_process\.executable/u);
  assert.match(claudeSkill, /next_process\.argv/u);
  assert.match(claudeSkill, /next_process\.cwd/u);
  assert.match(claudeSkill, /next_process\.env_overrides/u);
  assert.match(claudeSkill, /shell: false/u);
  assert.match(claudeSkill, /creatorcut cards submit/u);
  assert.match(claudeSkill, /AskUserQuestion/u);
  assert.match(openClawSkill, /creatorcut __openclaw-bridge/u);
  assert.match(openClawSkill, /CREATORCUT_OPENCLAW_REQUEST_JSON/u);
  assert.match(
    openClawSkill,
    /JSON\.stringify\(\{\s*argv,\s*stdin_mode: "none"\s*\}\)/su,
  );
  assert.match(openClawSkill, /Do not stringify `argv` by itself/u);
  assert.match(openClawSkill, /never concatenate the example into shell text/u);
  assert.match(openClawSkill, /next_openclaw\.exec/u);
  assert.match(openClawSkill, /json-line-v1/u);
  assert.match(openClawSkill, /process\.write/u);
  assert.match(openClawSkill, /process\.submit/u);
  assert.match(openClawSkill, /\["cards", "submit"/u);
  assert.match(openClawSkill, /Never transport an API key/iu);
  assert.match(
    openClawSkill,
    /\["auth", "status", "--project", "<same project>"\]/u,
  );
  assert.match(openClawSkill, /resumes the scoped `onboard` flow/u);
  assert.match(openClawSkill, /semantic text presentation/u);
  assert.doesNotMatch(openClawSkill, /AskUserQuestion/u);
  assert.match(
    openClawReadme,
    /openclaw skills install \.\/skills\/openclaw-creatorcut --as creatorcut --force/u,
  );
  assert.match(openClawReadme, /cwd-inferred\/default agent workspace/u);
  assert.match(openClawReadme, /--agent YOUR_AGENT_ID/u);
  assert.match(openClawReadme, /use `--global`\s+only/iu);
});
