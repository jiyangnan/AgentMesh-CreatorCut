import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const shim = resolve(root, "tests", "host-smoke", "bin", "creatorcut");
const fixtureDirectory = resolve(
  root,
  "tests",
  "fixtures",
  "cycle3-closeout-v1",
);
const project = "/synthetic/cycle3.creatorcut";

async function invoke(args, stdin) {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(shim, args, {
      cwd: root,
      env: {
        ...process.env,
        CREATORCUT_HOST_TYPE: "text",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolveResult({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(stdin);
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.schema_version, "creatorcut-cli/1.0");
  assert.equal(envelope.ok, true);
  return envelope;
}

test("generic text host submits the locked fixture using shown tokens", async () => {
  const fixture = JSON.parse(
    await readFile(
      resolve(fixtureDirectory, "cycle3-closeout-v1.json"),
      "utf8",
    ),
  );
  const lock = JSON.parse(
    await readFile(
      resolve(fixtureDirectory, "cycle3-closeout-v1.lock.json"),
      "utf8",
    ),
  );

  await invoke(["doctor"]);
  const projectStatus = await invoke([
    "project",
    "status",
    "--project",
    project,
  ]);
  assert.equal(projectStatus.data.revision, 3);
  const recovered = await invoke(["director", "status", "--project", project]);
  assert.equal(
    recovered.data.status.session_id,
    fixture.envelope_chain.direction_card.session_id,
  );

  const inspected = await invoke([
    "director",
    "context",
    "inspect",
    "--project",
    project,
  ]);
  assert.equal(inspected.requires_user_action, true);
  assert.equal(
    inspected.data.canonical_digest,
    fixture.envelope_chain.direction_card.planning_input_digest,
  );
  assert.deepEqual(inspected.data.excluded_fields, [
    "original_media",
    "screenshots",
    "absolute_paths",
    "usernames",
  ]);
  await invoke([
    "director",
    "context",
    "consent",
    "--project",
    project,
    "--confirm-upload",
  ]);
  await invoke(["director", "start", "--project", project]);

  const cards = await invoke(["cards", "get", "--project", project]);
  const presentation = cards.data.presentation;
  assert.equal(cards.requires_user_action, true);
  assert.equal(presentation.host_type, "text");
  assert.equal(
    presentation.presentation_digest,
    fixture.host_interaction.canonical_presentation.presentation_digest,
  );
  assert.equal(
    presentation.cards.every((card) => card.render_mode === "text-fallback"),
    true,
  );
  for (const card of presentation.cards) {
    assert.match(
      presentation.text_fallback,
      new RegExp(`\\[${card.card_id}\\]`),
    );
  }

  const submission = {
    answer_set_id: cards.data.answer_set_id,
    presentation_id: presentation.presentation_id,
    presentation_digest: presentation.presentation_digest,
    responses: [
      { card_id: "card_platform", selected_values: ["4"] },
      { card_id: "card_target_duration", selected_values: ["1"] },
      { card_id: "card_pace", selected_values: ["1"] },
      { card_id: "card_must_keep", selected_values: ["3"] },
      {
        card_id: "card_terms",
        text_value:
          "CreatorCut、Export the final video、Export、the、final、video",
      },
      { card_id: "card_caption_style", selected_values: ["2"] },
      { card_id: "card_voice", selected_values: ["1"] },
      { card_id: "card_review", approved: true },
    ],
  };
  const submitted = await invoke(
    ["cards", "submit", "--project", project],
    `${JSON.stringify(submission)}\n`,
  );
  assert.deepEqual(submitted.data.state, {
    fixture_id: fixture.fixture_id,
    host_type: "text",
    answer_set_id: fixture.host_interaction.expected_answer_set.answer_set_id,
    answer_set_digest: lock.expected_answer_set_digest,
    accepted: true,
    synthetic: true,
  });
});
