import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDirectory = resolve(
  root,
  "tests",
  "fixtures",
  "cycle3-closeout-v1",
);
const fixturePath = resolve(fixtureDirectory, "cycle3-closeout-v1.json");
const lockPath = resolve(fixtureDirectory, "cycle3-closeout-v1.lock.json");
const [protocol, operations, runtime, mediaEngine, fixtureText, lockText] =
  await Promise.all([
    import(
      pathToFileURL(resolve(root, "packages/protocol/dist/src/index.js")).href
    ),
    import(
      pathToFileURL(
        resolve(root, "packages/operations-contract/dist/src/index.js"),
      ).href
    ),
    import(
      pathToFileURL(resolve(root, "packages/runtime/dist/src/index.js")).href
    ),
    import(
      pathToFileURL(resolve(root, "packages/media-engine/dist/src/index.js"))
        .href
    ),
    readFile(fixturePath, "utf8"),
    readFile(lockPath, "utf8"),
  ]);

const fixture = JSON.parse(fixtureText);
const fixtureLock = JSON.parse(lockText);

function verifiedFixtureChain() {
  const recoveryRoots = new Map(
    fixture.recovery_roots.roots.map((rootEntry) => [
      rootEntry.key_id,
      rootEntry.public_key_pem,
    ]),
  );
  const now = new Date(fixture.fixed_clock.manifest);
  const keyset = protocol.verifySignedKeyset(
    fixture.signed_keyset,
    recoveryRoots,
    {
      purpose: "director",
      minimumVersion: 1,
      now,
    },
  );
  const chain = [
    fixture.envelope_chain.direction_card,
    fixture.envelope_chain.look_and_sound_card,
    fixture.envelope_chain.quote,
    fixture.envelope_chain.review_plan,
    fixture.envelope_chain.manifest,
  ];
  let previousDigest;
  for (const [index, envelope] of chain.entries()) {
    assert.deepEqual(
      protocol.verifyDirectorEnvelope(envelope, keyset, { now }),
      envelope,
    );
    assert.equal(envelope.sequence, index + 1);
    assert.equal(envelope.previous_envelope_digest, previousDigest);
    assert.equal(envelope.project_id, fixture.director_context.project_id);
    assert.equal(
      envelope.base_revision,
      fixture.director_context.base_revision,
    );
    assert.equal(
      envelope.planning_input_digest,
      protocol.digestJcs(fixture.director_context),
    );
    assert.equal(
      envelope.transcript_digest,
      fixture.director_context.transcript_digest,
    );
    assert.equal(
      envelope.timeline_digest,
      fixture.director_context.timeline_digest,
    );
    assert.equal(
      envelope.edit_brief_digest,
      fixture.director_context.edit_brief_digest,
    );
    assert.equal(
      envelope.capabilities_digest,
      fixture.director_context.capabilities_digest,
    );
    previousDigest = protocol.digestJcs(envelope);
  }
  return { chain, keyset, now };
}

async function localFixtureProject() {
  const directory = join(
    await mkdtemp(join(tmpdir(), "creatorcut-cycle3-closeout-")),
    "fixture.creatorcut",
  );
  const snapshot = fixture.local_snapshot;
  await runtime.createCreatorCutProject(directory, {
    project: snapshot.project,
    timeline: snapshot.timeline,
    transcript: snapshot.transcript,
    editBrief: snapshot.edit_brief,
  });
  const sourcePath = join(directory, snapshot.project.assets[0].relative_path);
  await writeFile(sourcePath, snapshot.synthetic_media_stub_utf8);
  assert.equal(
    createHash("sha256")
      .update(snapshot.synthetic_media_stub_utf8, "utf8")
      .digest("hex"),
    snapshot.synthetic_media_stub_sha256,
  );
  return directory;
}

function fixtureMediaRunner() {
  const removed = fixture.envelope_chain.manifest.payload.operations.reduce(
    (sum, operation) =>
      sum +
      operation.parameters.timeline_end_us -
      operation.parameters.timeline_start_us,
    0,
  );
  const durationSeconds =
    (fixture.local_snapshot.timeline.duration_us - removed) / 1_000_000;
  return async (command, args) => {
    if (command.includes("ffprobe")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          format: { duration: String(durationSeconds) },
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 1920,
              height: 1080,
              avg_frame_rate: "30/1",
            },
            {
              codec_type: "audio",
              codec_name: "aac",
              sample_rate: "48000",
              channels: 2,
            },
          ],
        }),
        stderr: "",
      };
    }
    const output = args.at(-1);
    if (output) await writeFile(output, "cycle3-closeout-rendered-preview");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

test("real Server fixture is sanitized, digest-locked and independently verifiable", () => {
  assert.equal(fixture.fixture_id, "cycle3-closeout-v1");
  assert.equal(fixture.synthetic, true);
  assert.equal(protocol.digestJcs(fixture), fixtureLock.fixture_digest);
  assert.equal(
    Buffer.byteLength(fixtureText.trimEnd(), "utf8"),
    fixtureLock.canonical_bytes,
  );
  assert.equal(protocol.canonicalizeJcs(fixture), fixtureText.trimEnd());
  const { chain } = verifiedFixtureChain();
  assert.equal(chain[0].previous_envelope_digest, undefined);
  assert.equal(
    protocol.digestJcs(fixture.envelope_chain.manifest),
    fixtureLock.manifest_envelope_digest,
  );
  assert.equal(
    protocol.digestJcs(fixture.host_interaction.expected_answer_set),
    fixtureLock.expected_answer_set_digest,
  );
  for (const forbidden of [
    "BEGIN PRIVATE KEY",
    "fixture-api-key",
    "service_token",
    "api_key",
    "/Users/",
    "/home/",
    "AgentMesh360-Client",
  ]) {
    assert.equal(fixtureText.includes(forbidden), false);
  }
});

test("fixture snapshot rebuilds the exact DirectorContext without Server code", async () => {
  const directory = await localFixtureProject();
  const opened = await runtime.openCreatorCutProject(directory);
  assert.deepEqual(
    runtime.buildDirectorContext(opened, { hostType: "text" }),
    fixture.director_context,
  );
});

test("verified remove_range fixture previews and applies transactionally", async () => {
  verifiedFixtureChain();
  const manifest = fixture.envelope_chain.manifest;
  assert.equal(
    manifest.payload.operations.length,
    fixture.expected.operation_count,
  );
  for (const operation of manifest.payload.operations) {
    assert.equal(
      operations.assertCreatorCutOperation(operation).operation_type,
      "remove_range",
    );
  }
  const directory = await localFixtureProject();
  const result = await mediaEngine.previewSignedManifest(
    directory,
    manifest,
    undefined,
    { runner: fixtureMediaRunner() },
  );
  const applied = await mediaEngine.applyPreviewedManifest(
    directory,
    manifest,
    result.confirmation.confirmation_token,
  );
  assert.equal(
    applied.opened.project.revision,
    fixture.expected.applied_revision,
  );
  assert.equal(
    applied.opened.timeline.revision,
    fixture.expected.applied_revision,
  );
  assert.equal(
    applied.opened.timeline.duration_us,
    fixture.local_snapshot.timeline.duration_us - 930_000,
  );
  assert.equal(
    applied.manifest_digest,
    fixture.expected.manifest_envelope_digest,
  );
});

test("fixture verification fails closed on keyset, signature, chain, binding and operation tampering", () => {
  const { keyset, now } = verifiedFixtureChain();
  const badKeyset = structuredClone(fixture.signed_keyset);
  badKeyset.signature.value = "AA==";
  const roots = new Map(
    fixture.recovery_roots.roots.map((rootEntry) => [
      rootEntry.key_id,
      rootEntry.public_key_pem,
    ]),
  );
  assert.throws(
    () =>
      protocol.verifySignedKeyset(badKeyset, roots, {
        purpose: "director",
        minimumVersion: 1,
        now,
      }),
    /keyset signature/u,
  );

  const cases = [
    [
      "signature",
      (value) => {
        value.signature.value = "AA==";
      },
    ],
    [
      "chain",
      (value) => {
        value.previous_envelope_digest = `sha256:${"0".repeat(64)}`;
      },
    ],
    [
      "revision",
      (value) => {
        value.base_revision += 1;
      },
    ],
    [
      "planning input",
      (value) => {
        value.planning_input_digest = `sha256:${"1".repeat(64)}`;
      },
    ],
    [
      "transcript input",
      (value) => {
        value.transcript_digest = `sha256:${"2".repeat(64)}`;
      },
    ],
    [
      "project identifier",
      (value) => {
        value.project_id = "project-tampered";
      },
    ],
    [
      "Generation identifier",
      (value) => {
        value.generation_id = "generation-tampered";
      },
    ],
    [
      "operation",
      (value) => {
        value.payload.operations[0].parameters.timeline_start_us += 1;
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const changed = structuredClone(fixture.envelope_chain.manifest);
    mutate(changed);
    assert.throws(
      () => protocol.verifyDirectorEnvelope(changed, keyset, { now }),
      /signature/u,
      name,
    );
  }
});
