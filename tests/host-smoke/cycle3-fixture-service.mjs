import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDirectory = resolve(
  root,
  "tests",
  "fixtures",
  "cycle3-closeout-v1",
);

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function assertExpectedDigest(name, expected, actual) {
  if (expected !== undefined && expected !== actual) {
    throw new TypeError(
      `CreatorCut ${name} changed; read the current cards again`,
    );
  }
}

export async function createCycle3FixtureService(options = {}) {
  const hostType = options.hostType ?? "codex";
  if (!["codex", "claude_code", "openclaw", "text"].includes(hostType)) {
    throw new TypeError("CREATORCUT_HOST_TYPE is invalid");
  }

  const [fixtureText, lockText, protocol, hostAdapters] = await Promise.all([
    readFile(resolve(fixtureDirectory, "cycle3-closeout-v1.json"), "utf8"),
    readFile(resolve(fixtureDirectory, "cycle3-closeout-v1.lock.json"), "utf8"),
    import(
      pathToFileURL(resolve(root, "packages/protocol/dist/src/index.js")).href
    ),
    import(
      pathToFileURL(resolve(root, "packages/host-adapters/dist/src/index.js"))
        .href
    ),
  ]);
  const fixture = JSON.parse(fixtureText);
  const lock = JSON.parse(lockText);
  if (protocol.digestJcs(fixture) !== lock.fixture_digest) {
    throw new Error("Cycle 3 fixture digest does not match its lock");
  }

  const envelope = fixture.envelope_chain.direction_card;
  const presentation = hostAdapters.presentSemanticCards(
    envelope.payload,
    hostAdapters.capabilitiesForHost(hostType),
    {
      presentationId:
        fixture.host_interaction.canonical_presentation.presentation_id,
    },
  );
  if (
    presentation.presentation_digest !==
    fixture.host_interaction.canonical_presentation.presentation_digest
  ) {
    throw new Error("Cycle 3 canonical presentation digest drifted");
  }
  const envelopeDigest = protocol.digestJcs(envelope);
  const expectedAnswerSet = fixture.host_interaction.expected_answer_set;
  const evidencePath = options.evidencePath;

  const cardPayload = () => ({
    envelope_id: envelope.artifact_id,
    envelope_digest: envelopeDigest,
    presentation_digest: presentation.presentation_digest,
    render_digest: presentation.render_digest,
    presentation,
  });

  const record = async (event, payload) => {
    if (!evidencePath) return;
    let current = {
      schema_version: "creatorcut-cycle3-host-smoke-evidence/1.0",
      fixture_id: fixture.fixture_id,
      host_type: hostType,
      events: [],
    };
    try {
      const parsed = JSON.parse(await readFile(evidencePath, "utf8"));
      if (
        parsed.fixture_id === fixture.fixture_id &&
        parsed.host_type === hostType &&
        Array.isArray(parsed.events)
      ) {
        current = parsed;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    current.events.push({
      event,
      payload_digest: protocol.digestJcs(payload),
      payload,
    });
    await writeJsonAtomic(evidencePath, current);
  };

  return {
    async projectStatus() {
      return {
        project_id: fixture.director_context.project_id,
        name: fixture.local_snapshot.project.name,
        revision: fixture.director_context.base_revision,
        language_mode: fixture.local_snapshot.transcript.language_mode,
        transcript_segments: fixture.local_snapshot.transcript.segments.length,
        director_consent: true,
        fixture_id: fixture.fixture_id,
        synthetic: true,
      };
    },

    async inspectContext() {
      return {
        inspection: {
          context: fixture.director_context,
          canonical_digest: protocol.digestJcs(fixture.director_context),
          utf8_bytes: Buffer.byteLength(
            protocol.canonicalizeJcs(fixture.director_context),
            "utf8",
          ),
          excluded_fields: [
            "original_media",
            "screenshots",
            "absolute_paths",
            "usernames",
          ],
          fixture_id: fixture.fixture_id,
          synthetic: true,
        },
      };
    },

    async approveContext() {
      return {
        consent: {
          fixture_id: fixture.fixture_id,
          planning_input_digest: protocol.digestJcs(fixture.director_context),
          approved: true,
          synthetic: true,
        },
      };
    },

    async startDirector() {
      return {
        state: {
          session_id: envelope.session_id,
          session_stage: envelope.payload.stage,
          state_revision: envelope.payload.state_revision,
          fixture_id: fixture.fixture_id,
          synthetic: true,
        },
      };
    },

    async getCards() {
      const payload = cardPayload();
      await record("cards_get", payload);
      return payload;
    },

    async renderCards(expected) {
      const payload = cardPayload();
      assertExpectedDigest(
        "card envelope",
        expected.envelopeDigest,
        payload.envelope_digest,
      );
      assertExpectedDigest(
        "card presentation",
        expected.presentationDigest,
        payload.presentation_digest,
      );
      assertExpectedDigest(
        "host rendering",
        expected.renderDigest,
        payload.render_digest,
      );
      const rendered = {
        answer_set_id: expectedAnswerSet.answer_set_id,
        ...payload,
      };
      await record("cards_render", rendered);
      return rendered;
    },

    async submitCards({ submission }) {
      if (submission.answer_set_id !== expectedAnswerSet.answer_set_id) {
        throw new TypeError(
          "CreatorCut host smoke requires the fixture answer_set_id",
        );
      }
      const answers = hostAdapters.normalizeHostSubmission(
        envelope.payload,
        presentation,
        submission,
      );
      const answerSet = {
        ...expectedAnswerSet,
        answers,
        presentation_digest: presentation.presentation_digest,
      };
      const answerSetDigest = protocol.digestJcs(answerSet);
      if (answerSetDigest !== lock.expected_answer_set_digest) {
        throw new TypeError(
          "CreatorCut normalized AnswerSet does not match the locked fixture",
        );
      }
      const accepted = {
        state: {
          fixture_id: fixture.fixture_id,
          host_type: hostType,
          answer_set_id: answerSet.answer_set_id,
          answer_set_digest: answerSetDigest,
          accepted: true,
          synthetic: true,
        },
      };
      await record("cards_submit", accepted);
      return accepted;
    },

    async quote() {
      return { quote_envelope: fixture.envelope_chain.quote };
    },

    async status() {
      return {
        status: {
          session_id: envelope.session_id,
          session_stage: "review",
          state_revision: 2,
          answer_set_digest: lock.expected_answer_set_digest,
          fixture_id: fixture.fixture_id,
          synthetic: true,
        },
      };
    },

    async review() {
      return { review_envelope: fixture.envelope_chain.review_plan };
    },

    async preview() {
      throw new Error(
        "Synthetic host smoke stops before local media preview; use the signed execution fixture test",
      );
    },

    async apply() {
      throw new Error(
        "Synthetic host smoke cannot mutate a local project; use the signed execution fixture test",
      );
    },

    async undo() {
      throw new Error("Synthetic host smoke has no mutable project");
    },

    async redo() {
      throw new Error("Synthetic host smoke has no mutable project");
    },

    async exportStart() {
      throw new Error("Synthetic host smoke does not export media");
    },

    async exportStatus() {
      throw new Error("Synthetic host smoke does not export media");
    },

    async exportResume() {
      throw new Error("Synthetic host smoke does not export media");
    },

    async exportCancel() {
      throw new Error("Synthetic host smoke does not export media");
    },

    async transcriptionStart() {
      throw new Error("Synthetic host smoke does not run transcription");
    },

    async transcriptionStatus() {
      throw new Error("Synthetic host smoke does not run transcription");
    },

    async transcriptionResume() {
      throw new Error("Synthetic host smoke does not run transcription");
    },

    async transcriptionCancel() {
      throw new Error("Synthetic host smoke does not run transcription");
    },
  };
}
