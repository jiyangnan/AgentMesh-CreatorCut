#!/usr/bin/env node

/**
 * Checked-in synthetic harness for the Darwin secure-swap prototype.
 *
 * Safety contract:
 * - requires Node 24 on Darwin;
 * - accepts two immutable helper binaries and one caller-created synthetic root;
 * - creates one fresh retained run directory below that root;
 * - never removes, truncates, or overwrites a file or directory;
 * - never reads or writes a CreatorCut project outside the retained run directory.
 *
 * Usage:
 *   node harness.mjs \
 *     --normal-helper /absolute/path/to/secure-swap \
 *     --synthetic-helper /absolute/path/to/secure-swap-synthetic \
 *     --barrier-launcher /absolute/path/to/secure-swap-barrier-launcher \
 *     --temp-root /absolute/path/to/caller-owned-empty-or-retained-temp-root
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { constants as fsConstants } from "node:fs";
import {
  appendFile,
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAGIC = Buffer.from("CCSW", "ascii");
const PROTOCOL_SCHEMA = 1;
const DIGEST_SCHEMA = 2;
const WAL_SCHEMA = 2;
const BUILD_ID = Buffer.from("CCSW-M1-PROTOTYPE-20260810-0001D", "ascii");

const OP_PROBE = 1;
const OP_CAPABILITIES = 2;
const OP_SWAP_FORWARD = 3;
const OP_RECOVER_FORWARD = 4;

const STATUS_PROTOCOL = 1;
const STATUS_UNSUPPORTED = 2;
const STATUS_INVALID_REQUEST = 3;
const STATUS_IO = 4;
const STATUS_UNSAFE_OBJECT = 5;
const STATUS_LIMIT = 6;
const STATUS_CONFLICT = 7;
const STATUS_WAL = 8;
const STATUS_CAPABILITY = 9;
const STATUS_INTERNAL = 10;
const STATUS_RECOVERY_REQUIRED = 11;
const KNOWN_STATUSES = new Set([
  0,
  STATUS_PROTOCOL,
  STATUS_UNSUPPORTED,
  STATUS_INVALID_REQUEST,
  STATUS_IO,
  STATUS_UNSAFE_OBJECT,
  STATUS_LIMIT,
  STATUS_CONFLICT,
  STATUS_WAL,
  STATUS_CAPABILITY,
  STATUS_INTERNAL,
  STATUS_RECOVERY_REQUIRED,
]);

const MAX_FRAME = 128 * 1024;
const MAX_STDERR = 64 * 1024;
const BARRIER_FD = 198;
const HARNESS_CHANNEL_FD = 3;
const BARRIER_EVENT_TAG = 0x42;
const BARRIER_ACK_TAG = 0x41;
const BARRIER_AFTER_PREPARED = 1 << 0;
const BARRIER_AFTER_SWAP_SYSCALL = 1 << 1;
const BARRIER_AFTER_ROOT_SYNC = 1 << 2;
const BARRIER_AFTER_SWAPPED = 1 << 3;
const BARRIER_AFTER_COMMITTED = 1 << 4;
const BARRIERS = [
  {
    name: "after-prepared",
    point: BARRIER_AFTER_PREPARED,
    mapping: "pre",
    phases: [1],
  },
  {
    name: "after-swap-syscall",
    point: BARRIER_AFTER_SWAP_SYSCALL,
    mapping: "post",
    phases: [1],
  },
  {
    name: "after-root-sync",
    point: BARRIER_AFTER_ROOT_SYNC,
    mapping: "post",
    phases: [1],
  },
  {
    name: "after-swapped",
    point: BARRIER_AFTER_SWAPPED,
    mapping: "post",
    phases: [1, 2],
  },
  {
    name: "after-committed",
    point: BARRIER_AFTER_COMMITTED,
    mapping: "post",
    phases: [1, 2, 3],
  },
];

const CAP_SWAP = 1 << 0;
const CAP_FLOCK = 1 << 1;
const PROCESS_TIMEOUT_MS = 15_000;

const ACTIVE_NAME = ".creatorcut";
const CONTROL_NAME = ".creatorcut-control";
const WAL_DIRECTORY_NAME = "wal";
const LOCK_NAME = "writer.lock";
const STAGE_PREFIX = ".creatorcut-swap-";
const PROTOTYPE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CANDIDATE_SOURCE_FILES = [
  "main.rs",
  "sha256.rs",
  "darwin_shim.c",
  "darwin_shim.h",
  "barrier_launcher.c",
  "harness.mjs",
];

function usage() {
  return [
    "Usage:",
    "  node harness.mjs --normal-helper /abs/normal --synthetic-helper /abs/synthetic --barrier-launcher /abs/launcher --temp-root /abs/root",
    "",
    "The harness creates and retains a new secure-swap-harness-* directory below --temp-root.",
  ].join("\n");
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = 0;
    return null;
  }
  const allowed = new Set([
    "--normal-helper",
    "--synthetic-helper",
    "--barrier-launcher",
    "--temp-root",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert.equal(typeof key, "string", usage());
    assert(allowed.has(key), `Unknown argument: ${key}\n${usage()}`);
    assert.equal(
      typeof value,
      "string",
      `Missing value for ${key}\n${usage()}`,
    );
    assert(!values.has(key), `Duplicate argument: ${key}`);
    values.set(key, value);
  }
  assert.equal(values.size, 4, usage());
  const output = {
    normalHelper: values.get("--normal-helper"),
    syntheticHelper: values.get("--synthetic-helper"),
    barrierLauncher: values.get("--barrier-launcher"),
    tempRoot: values.get("--temp-root"),
  };
  for (const [name, value] of Object.entries(output)) {
    assert.equal(typeof value, "string", `Missing ${name}`);
    assert(isAbsolute(value), `${name} must be an absolute path`);
  }
  return output;
}

function assertInside(parent, target, { allowEqual = false } = {}) {
  const parentPath = resolve(parent);
  const targetPath = resolve(target);
  const rel = relative(parentPath, targetPath);
  const inside =
    rel === ""
      ? allowEqual
      : rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  assert(inside, `Path escapes synthetic run root: ${targetPath}`);
  return targetPath;
}

async function validateHelper(path, label) {
  const normalized = resolve(path);
  assert.equal(path, normalized, `${label} path must be normalized`);
  const resolved = await realpath(path);
  assert.equal(resolved, path, `${label} must not be a symlink`);
  const stat = await lstat(path);
  assert(stat.isFile(), `${label} must be a regular file`);
  assert((stat.mode & 0o111) !== 0, `${label} must be executable`);
  assert.equal(
    stat.mode & 0o022,
    0,
    `${label} must not be group/world writable`,
  );
  if (typeof process.getuid === "function") {
    assert.equal(
      stat.uid,
      process.getuid(),
      `${label} must be owned by the current UID`,
    );
  }
  return path;
}

async function validateTempRoot(path) {
  const normalized = resolve(path);
  assert.equal(path, normalized, "--temp-root must be normalized");
  const resolved = await realpath(path);
  assert.equal(
    resolved,
    path,
    "--temp-root must not contain a symlink component",
  );
  const stat = await lstat(path);
  assert(stat.isDirectory(), "--temp-root must be a directory");
  assert.equal(
    stat.mode & 0o077,
    0,
    "--temp-root must be private to its owner",
  );
  if (typeof process.getuid === "function") {
    assert.equal(
      stat.uid,
      process.getuid(),
      "--temp-root must be owned by the current UID",
    );
  }
  return path;
}

function sha256(...parts) {
  const hasher = createHash("sha256");
  for (const part of parts) hasher.update(part);
  return hasher.digest();
}

async function retainCandidateArtifacts(
  runRoot,
  { normalHelper, syntheticHelper, barrierLauncher },
) {
  const directory = join(runRoot, "candidate-artifacts");
  await mkdirSecure(directory, runRoot);
  const records = [];

  async function retain(role, source, retainedName, mode) {
    const retained = join(directory, retainedName);
    assertInside(runRoot, retained);
    await copyFile(source, retained, fsConstants.COPYFILE_EXCL);
    await chmod(retained, mode);
    const [sourceBytes, retainedBytes] = await Promise.all([
      readFile(source),
      readFile(retained),
    ]);
    assert(
      sourceBytes.equals(retainedBytes),
      `${role} changed while being retained`,
    );
    const record = {
      role,
      source,
      retained,
      bytes: retainedBytes.length,
      sha256: sha256(retainedBytes).toString("hex"),
    };
    records.push(record);
    return retained;
  }

  const retainedNormal = await retain(
    "normal-helper",
    normalHelper,
    "secure-swap-normal",
    0o500,
  );
  const retainedSynthetic = await retain(
    "synthetic-helper",
    syntheticHelper,
    "secure-swap-synthetic",
    0o500,
  );
  const retainedLauncher = await retain(
    "barrier-launcher",
    barrierLauncher,
    "secure-swap-barrier-launcher",
    0o500,
  );
  for (const name of CANDIDATE_SOURCE_FILES) {
    await retain(
      `source:${name}`,
      join(PROTOTYPE_DIRECTORY, name),
      `source-${name}`,
      0o400,
    );
  }
  records.sort((left, right) => left.role.localeCompare(right.role, "en"));
  const manifestHasher = createHash("sha256");
  manifestHasher.update(Buffer.from("CCSW-CANDIDATE-MANIFEST-V1\0", "ascii"));
  for (const record of records) {
    manifestHasher.update(Buffer.from(record.role, "utf8"));
    manifestHasher.update(Buffer.from([0]));
    manifestHasher.update(Buffer.from(record.sha256, "ascii"));
    manifestHasher.update(Buffer.from([0]));
  }
  return {
    normalHelper: retainedNormal,
    syntheticHelper: retainedSynthetic,
    barrierLauncher: retainedLauncher,
    records,
    digest: manifestHasher.digest("hex"),
  };
}

function deriveBytes(label, length) {
  const output = sha256(Buffer.from(`creatorcut-harness:${label}`, "utf8"));
  assert(length <= output.length);
  const value = output.subarray(0, length);
  assert(
    value.some((byte) => byte !== 0),
    `Derived zero identifier for ${label}`,
  );
  return Buffer.from(value);
}

function uuidText(bytes) {
  assert.equal(bytes.length, 16);
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function u16(value) {
  assert(Number.isInteger(value) && value >= 0 && value <= 0xffff);
  const output = Buffer.allocUnsafe(2);
  output.writeUInt16BE(value);
  return output;
}

function u32(value) {
  assert(Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff);
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32BE(value);
  return output;
}

function u64(value) {
  const number = BigInt(value);
  assert(number >= 0n && number <= 0xffff_ffff_ffff_ffffn);
  const output = Buffer.allocUnsafe(8);
  output.writeBigUInt64BE(number);
  return output;
}

function bytesU16(bytes) {
  assert(bytes.length <= 0xffff, "u16 byte field is too large");
  return Buffer.concat([u16(bytes.length), bytes]);
}

function requestBody(opcode, payload = Buffer.alloc(0), flags = 0) {
  assert(Number.isInteger(opcode) && opcode >= 0 && opcode <= 0xff);
  assert(Number.isInteger(flags) && flags >= 0 && flags <= 0xff);
  return Buffer.concat([
    MAGIC,
    u16(PROTOCOL_SCHEMA),
    Buffer.from([opcode, flags]),
    payload,
  ]);
}

function frame(body) {
  assert(
    body.length >= 8 && body.length <= MAX_FRAME,
    "request body length rejected by harness",
  );
  return Buffer.concat([u32(body.length), body]);
}

function probeBody(challenge, extra = Buffer.alloc(0)) {
  assert.equal(challenge.length, 32);
  return requestBody(OP_PROBE, Buffer.concat([challenge, extra]));
}

function capabilitiesBody(session, root) {
  const rootBytes = Buffer.from(root, "utf8");
  assert(rootBytes.length <= 4096 && !rootBytes.includes(0));
  return requestBody(
    OP_CAPABILITIES,
    Buffer.concat([session, bytesU16(rootBytes)]),
  );
}

function swapBody(
  session,
  fixture,
  barrierMask = 0,
  rootOverride = fixture.projectRoot,
) {
  const rootBytes = Buffer.from(rootOverride, "utf8");
  assert(rootBytes.length <= 4096 && !rootBytes.includes(0));
  return requestBody(
    OP_SWAP_FORWARD,
    Buffer.concat([
      session,
      fixture.tx,
      fixture.projectUuid,
      fixture.nonce,
      fixture.markerDigest,
      u64(fixture.generation),
      u32(barrierMask),
      bytesU16(rootBytes),
    ]),
  );
}

function recoverBody(
  session,
  fixture,
  barrierMask = 0,
  rootOverride = fixture.projectRoot,
) {
  const rootBytes = Buffer.from(rootOverride, "utf8");
  assert(rootBytes.length <= 4096 && !rootBytes.includes(0));
  return requestBody(
    OP_RECOVER_FORWARD,
    Buffer.concat([session, fixture.tx, u32(barrierMask), bytesU16(rootBytes)]),
  );
}

function decodeResponse(body, expectedOpcode) {
  assert(
    body.length >= 12,
    "response body is shorter than the common envelope",
  );
  assert(body.subarray(0, 4).equals(MAGIC), "response magic mismatch");
  assert.equal(
    body.readUInt16BE(4),
    PROTOCOL_SCHEMA,
    "response schema mismatch",
  );
  assert.equal(body[6], expectedOpcode, "response opcode mismatch");
  assert.equal(body[7], 0, "response flags must be zero");
  const status = body.readUInt16BE(8);
  assert(KNOWN_STATUSES.has(status), `unknown helper status: ${status}`);
  const messageLength = body.readUInt16BE(10);
  const messageEnd = 12 + messageLength;
  assert(messageEnd <= body.length, "response message is truncated");
  const message = body.subarray(12, messageEnd).toString("utf8");
  const payload = body.subarray(messageEnd);
  if (status === 0) {
    assert.equal(
      messageLength,
      0,
      "successful response must not contain an error message",
    );
  } else {
    assert(
      messageLength > 0,
      "failed response must contain a static error message",
    );
    assert.equal(
      payload.length,
      0,
      "failed response must not contain an operation payload",
    );
    assert(!message.includes("\0"), "error response contains a NUL byte");
    assert(message.length <= 512, "error response is unexpectedly large");
  }
  return { status, message, payload };
}

class BufferedReader {
  constructor(stream, label) {
    this.stream = stream;
    this.label = label;
    this.buffer = Buffer.alloc(0);
    this.ended = false;
    this.error = null;
    this.waiters = [];
    stream.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      this.#wake();
    });
    stream.once("end", () => {
      this.ended = true;
      this.#wake();
    });
    stream.once("error", (error) => {
      this.error = error;
      this.#wake();
    });
  }

  #wake() {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  async readExactly(length, timeoutMs = PROCESS_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (this.buffer.length < length) {
      if (this.error) throw this.error;
      if (this.ended) {
        throw new Error(
          `${this.label} ended with ${this.buffer.length} buffered bytes; needed ${length}`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`${this.label} read timed out`);
      await withTimeout(
        new Promise((resolveWaiter) => this.waiters.push(resolveWaiter)),
        remaining,
        `${this.label} read`,
      );
    }
    const output = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return Buffer.from(output);
  }

  async readFrame(timeoutMs = PROCESS_TIMEOUT_MS) {
    const lengthBytes = await this.readExactly(4, timeoutMs);
    const length = lengthBytes.readUInt32BE(0);
    assert(
      length >= 12 && length <= MAX_FRAME,
      `response frame length rejected: ${length}`,
    );
    return this.readExactly(length, timeoutMs);
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeAll(stream, bytes) {
  if (!stream.write(bytes)) await once(stream, "drain");
}

class HelperProcess {
  constructor(helperPath, scratchDirectory, { barrierLauncher = null } = {}) {
    const barrier = barrierLauncher !== null;
    const stdio = barrier
      ? ["pipe", "pipe", "pipe", "pipe"]
      : ["pipe", "pipe", "pipe"];
    const executable = barrier ? barrierLauncher : helperPath;
    const executableArguments = barrier ? [helperPath] : [];
    this.child = spawn(executable, executableArguments, {
      cwd: scratchDirectory,
      env: {
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
        TMPDIR: scratchDirectory,
      },
      stdio,
    });
    assert(this.child.stdin, "helper stdin pipe was not created");
    assert(this.child.stdout, "helper stdout pipe was not created");
    assert(this.child.stderr, "helper stderr pipe was not created");
    this.stdinError = null;
    this.child.stdin.on("error", (error) => {
      this.stdinError = error;
    });
    this.stdout = new BufferedReader(
      this.child.stdout,
      `${basename(helperPath)} stdout`,
    );
    this.barrierStream = barrier ? this.child.stdio[HARNESS_CHANNEL_FD] : null;
    if (barrier)
      assert(this.barrierStream, "helper barrier pipe was not created");
    this.barrierReader = barrier
      ? new BufferedReader(
          this.barrierStream,
          `${basename(helperPath)} barrier`,
        )
      : null;
    this.stderr = Buffer.alloc(0);
    this.child.stderr.on("data", (chunk) => {
      if (this.stderr.length >= MAX_STDERR) return;
      const available = MAX_STDERR - this.stderr.length;
      this.stderr = Buffer.concat([
        this.stderr,
        Buffer.from(chunk).subarray(0, available),
      ]);
    });
    this.child.stderr.on("error", () => {});
    this.exitResult = null;
    this.exitPromise = new Promise((resolveExit, rejectExit) => {
      this.child.once("error", rejectExit);
      this.child.once("exit", (code, signal) => {
        this.exitResult = { code, signal };
        resolveExit(this.exitResult);
      });
    });
  }

  async sendBody(body, { end = false } = {}) {
    if (this.stdinError) throw this.stdinError;
    await writeAll(this.child.stdin, frame(body));
    if (end) this.child.stdin.end();
  }

  async sendRaw(bytes, { end = false } = {}) {
    if (this.stdinError) throw this.stdinError;
    await writeAll(this.child.stdin, bytes);
    if (end) this.child.stdin.end();
  }

  async readResponse(expectedOpcode, timeoutMs = PROCESS_TIMEOUT_MS) {
    return decodeResponse(
      await this.stdout.readFrame(timeoutMs),
      expectedOpcode,
    );
  }

  async probe(label) {
    const challenge = deriveBytes(`${label}:probe`, 32);
    await this.sendBody(probeBody(challenge));
    const response = await this.readResponse(OP_PROBE);
    assert.equal(response.status, 0, `PROBE failed: ${response.message}`);
    assert.equal(response.payload.length, 100, "PROBE payload length mismatch");
    assert(
      response.payload.subarray(0, 32).equals(challenge),
      "PROBE challenge mismatch",
    );
    const session = response.payload.subarray(32, 64);
    const expectedSession = sha256(
      Buffer.from("CCSW-PROBE-SESSION-V1\0", "ascii"),
      challenge,
      BUILD_ID,
      u16(PROTOCOL_SCHEMA),
    );
    assert(session.equals(expectedSession), "PROBE session digest mismatch");
    assert(
      response.payload.subarray(64, 96).equals(BUILD_ID),
      "PROBE build ID mismatch",
    );
    assert.equal(
      response.payload.readUInt16BE(96),
      DIGEST_SCHEMA,
      "digest schema mismatch",
    );
    assert.equal(
      response.payload.readUInt16BE(98),
      WAL_SCHEMA,
      "WAL schema mismatch",
    );
    return Buffer.from(session);
  }

  async sendOperation(body) {
    await this.sendBody(body, { end: true });
  }

  async readBarrier(expectedPoint, expectedTx) {
    assert(this.barrierReader, "barrier channel was not requested");
    const event = await this.barrierReader.readExactly(21);
    assert.equal(event[0], BARRIER_EVENT_TAG, "barrier event tag mismatch");
    assert.equal(
      event.readUInt32BE(1),
      expectedPoint,
      "barrier point mismatch",
    );
    assert(
      event.subarray(5).equals(expectedTx),
      "barrier transaction mismatch",
    );
    return event;
  }

  async acknowledgeBarrier(point) {
    assert(this.barrierStream, "barrier channel was not requested");
    await writeAll(
      this.barrierStream,
      Buffer.concat([Buffer.from([BARRIER_ACK_TAG]), u32(point)]),
    );
  }

  async wait(timeoutMs = PROCESS_TIMEOUT_MS) {
    return withTimeout(
      this.exitPromise,
      timeoutMs,
      `${basename(this.child.spawnfile)} exit`,
    );
  }

  async kill(signal = "SIGKILL") {
    if (!this.exitResult) this.child.kill(signal);
    return this.wait();
  }

  async dispose() {
    if (!this.exitResult) {
      try {
        await this.kill("SIGKILL");
      } catch {
        // The primary case failure is more useful than a best-effort teardown error.
      }
    }
  }
}

function assertExitForResponse(exit, response, stderr) {
  if (response.status === 0) {
    assert.deepEqual(
      exit,
      { code: 0, signal: null },
      `helper failed: ${stderr}`,
    );
  } else {
    assert.equal(exit.signal, null, `helper died by signal: ${exit.signal}`);
    assert.equal(exit.code, 1, `failed response must exit 1; stderr=${stderr}`);
  }
}

async function transact(helper, scratchDirectory, label, buildBody) {
  const session = new HelperProcess(helper, scratchDirectory);
  try {
    const sessionDigest = await session.probe(label);
    const { opcode, body } = buildBody(sessionDigest);
    await session.sendOperation(body);
    const response = await session.readResponse(opcode);
    if (response.status !== 0) {
      assert(
        !response.message.includes(scratchDirectory),
        "helper error leaked the synthetic root path",
      );
    }
    const exit = await session.wait();
    assertExitForResponse(exit, response, session.stderr.toString("utf8"));
    return response;
  } finally {
    await session.dispose();
  }
}

async function expectStatus(response, expected, label) {
  const accepted = Array.isArray(expected) ? expected : [expected];
  assert(
    accepted.includes(response.status),
    `${label}: expected status ${accepted.join("/")}, received ${response.status} (${response.message})`,
  );
}

async function mkdirSecure(path, runRoot) {
  assertInside(runRoot, path);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function writeExclusive(path, bytes, runRoot, mode = 0o600) {
  assertInside(runRoot, path);
  await writeFile(path, bytes, { flag: "wx", mode });
  await chmod(path, mode);
}

async function createActive(active, runRoot, label) {
  await mkdirSecure(active, runRoot);
  await writeExclusive(
    join(active, "internal-state.json"),
    Buffer.from(`${JSON.stringify({ format: "internal", label })}\n`, "utf8"),
    runRoot,
  );
  const nested = join(active, "nested");
  await mkdirSecure(nested, runRoot);
  await writeExclusive(
    join(nested, "a.txt"),
    Buffer.from(`A:${label}\n`),
    runRoot,
  );
  await writeExclusive(
    join(nested, "b.txt"),
    Buffer.from(`B:${label}\n`),
    runRoot,
  );
  const deeper = join(nested, "deeper");
  await mkdirSecure(deeper, runRoot);
  await writeExclusive(
    join(deeper, "state.bin"),
    deriveBytes(`${label}:active`, 32),
    runRoot,
  );
}

async function createStage(stage, runRoot, label, projectUuid, generation) {
  await mkdirSecure(stage, runRoot);
  const marker = Buffer.from(
    `${JSON.stringify({
      schema_version: "creatorcut-storage-authority/1.0",
      authority: "public-runtime",
      project_id: uuidText(projectUuid),
      handoff_generation: Number(generation),
      fixture: label,
    })}\n`,
    "utf8",
  );
  const files = new Map([
    [
      "project.json",
      `${JSON.stringify({ schema_version: "creatorcut-project/1.0", project_id: uuidText(projectUuid), revision: 0, fixture: label })}\n`,
    ],
    [
      "timeline.json",
      `${JSON.stringify({ schema_version: "creatorcut-timeline/1.0", project_id: uuidText(projectUuid), revision: 0, tracks: [] })}\n`,
    ],
    [
      "history.json",
      `${JSON.stringify({ schema_version: "creatorcut-history/1.0", project_id: uuidText(projectUuid), current_revision: 0, revisions: [0] })}\n`,
    ],
    [
      "operations.jsonl",
      `${JSON.stringify({ operation: "synthetic_fixture", revision: 0, fixture: label })}\n`,
    ],
    ["storage-authority.json", marker],
    [
      "storage-mutations.jsonl",
      `${JSON.stringify({ mutation: "synthetic_handoff", generation: Number(generation), fixture: label })}\n`,
    ],
  ]);
  for (const [name, content] of files) {
    const bytes = Buffer.isBuffer(content)
      ? content
      : Buffer.from(content, "utf8");
    await writeExclusive(join(stage, name), bytes, runRoot);
  }
  const versions = join(stage, "versions");
  await mkdirSecure(versions, runRoot);
  await writeExclusive(
    join(versions, "0.json"),
    Buffer.from(`${JSON.stringify({ revision: 0, fixture: label })}\n`, "utf8"),
    runRoot,
  );
  const tasks = join(stage, "tasks");
  await mkdirSecure(tasks, runRoot);
  return { marker, markerDigest: sha256(marker) };
}

async function createControl(projectRoot, runRoot) {
  const control = join(projectRoot, CONTROL_NAME);
  const walDirectory = join(control, WAL_DIRECTORY_NAME);
  await mkdirSecure(control, runRoot);
  await mkdirSecure(walDirectory, runRoot);
  await writeExclusive(join(control, LOCK_NAME), Buffer.alloc(0), runRoot);
  return { control, walDirectory };
}

async function createFixture(caseContext, { containerName = null } = {}) {
  const { caseDirectory, name, runRoot } = caseContext;
  const projectContainer = containerName
    ? join(caseDirectory, containerName)
    : caseDirectory;
  if (containerName) await mkdirSecure(projectContainer, runRoot);
  const projectRoot = join(projectContainer, "project");
  await mkdirSecure(projectRoot, runRoot);
  const evidenceDirectory = join(caseDirectory, "retained-evidence");
  await mkdirSecure(evidenceDirectory, runRoot);
  const sentinel = join(caseDirectory, "outside-project-sentinel.bin");
  await writeExclusive(sentinel, deriveBytes(`${name}:sentinel`, 32), runRoot);

  const tx = deriveBytes(`${name}:tx`, 16);
  const projectUuid = deriveBytes(`${name}:project`, 16);
  const nonce = deriveBytes(`${name}:nonce`, 32);
  const generation = 1n;
  const stageName = `${STAGE_PREFIX}${tx.toString("hex")}`;
  const active = join(projectRoot, ACTIVE_NAME);
  const stage = join(projectRoot, stageName);
  await createActive(active, runRoot, name);
  const stageResult = await createStage(
    stage,
    runRoot,
    name,
    projectUuid,
    generation,
  );
  const control = await createControl(projectRoot, runRoot);
  return {
    name,
    runRoot,
    caseDirectory,
    evidenceDirectory,
    projectRoot,
    active,
    stage,
    stageName,
    sentinel,
    tx,
    projectUuid,
    nonce,
    generation,
    marker: stageResult.marker,
    markerDigest: stageResult.markerDigest,
    control: control.control,
    walDirectory: control.walDirectory,
    walPath: join(control.walDirectory, `${tx.toString("hex")}.wal`),
  };
}

function statType(stat) {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  if (stat.isCharacterDevice()) return "character";
  if (stat.isBlockDevice()) return "block";
  return "unknown";
}

async function treeManifest(root) {
  const output = [];
  async function walk(path, relativePath) {
    const stat = await lstat(path, { bigint: true });
    const type = statType(stat);
    const record = {
      path: relativePath,
      type,
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      nlink: stat.nlink.toString(),
      size: stat.size.toString(),
      mode: Number(stat.mode & 0o7777n),
    };
    if (type === "file")
      record.sha256 = sha256(await readFile(path)).toString("hex");
    if (type === "symlink") record.target = await readlink(path);
    output.push(record);
    if (type === "directory") {
      const names = await readdir(path);
      names.sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      );
      for (const name of names) {
        await walk(
          join(path, name),
          relativePath === "." ? name : `${relativePath}/${name}`,
        );
      }
    }
  }
  await walk(root, ".");
  return output;
}

async function sentinelSnapshot(fixture) {
  return treeManifest(fixture.sentinel);
}

async function initialMapping(fixture) {
  return {
    active: await treeManifest(fixture.active),
    stage: await treeManifest(fixture.stage),
    sentinel: await sentinelSnapshot(fixture),
  };
}

async function assertSentinel(fixture, expected) {
  assert.deepEqual(
    await sentinelSnapshot(fixture),
    expected,
    "external sentinel changed",
  );
}

async function assertMapping(fixture, expected, mapping) {
  const active = await treeManifest(fixture.active);
  const stage = await treeManifest(fixture.stage);
  if (mapping === "pre") {
    assert.deepEqual(
      active,
      expected.active,
      "active tree changed in pre mapping",
    );
    assert.deepEqual(
      stage,
      expected.stage,
      "stage tree changed in pre mapping",
    );
  } else {
    assert.equal(mapping, "post");
    assert.deepEqual(
      active,
      expected.stage,
      "active name does not contain the public stage",
    );
    assert.deepEqual(
      stage,
      expected.active,
      "quarantine name does not contain the old active tree",
    );
  }
  await assertSentinel(fixture, expected.sentinel);
}

function crc32(bytes) {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb8_8320 & mask);
    }
  }
  return ~crc >>> 0;
}

function decodeWalBinding(bytes) {
  let offset = 0;
  const take = (length) => {
    assert(offset + length <= bytes.length, "truncated WAL binding");
    const output = bytes.subarray(offset, offset + length);
    offset += length;
    return output;
  };
  const readU16 = () => take(2).readUInt16BE(0);
  const readU64 = () => take(8).readBigUInt64BE(0);
  const readBytesU16 = () => take(readU16());
  const bindingDomain = Buffer.from("CCSW-BINDING-V2\0", "ascii");
  assert(
    take(bindingDomain.length).equals(bindingDomain),
    "WAL binding domain mismatch",
  );
  assert.equal(readU16(), PROTOCOL_SCHEMA, "WAL protocol schema mismatch");
  assert.equal(readU16(), DIGEST_SCHEMA, "WAL digest schema mismatch");
  assert.equal(readU16(), WAL_SCHEMA, "WAL schema mismatch");
  assert(take(32).equals(BUILD_ID), "WAL build ID mismatch");
  const tx = Buffer.from(take(16));
  const projectUuid = Buffer.from(take(16));
  const nonce = Buffer.from(take(32));
  const generation = readU64();
  const markerDigest = Buffer.from(take(32));
  const rootPathDigest = Buffer.from(take(32));
  const STAT_BYTES = 80;
  take(STAT_BYTES); // direct parent stat
  take(STAT_BYTES); // project root stat
  const projectLeaf = Buffer.from(readBytesU16());
  const activeName = Buffer.from(readBytesU16());
  const stageName = Buffer.from(readBytesU16());
  take(STAT_BYTES); // old active stat
  const activeDigest = Buffer.from(take(32));
  take(STAT_BYTES); // staged public stat
  const stageDigest = Buffer.from(take(32));
  assert.equal(offset, bytes.length, "trailing WAL binding bytes");
  assert(
    tx.some((byte) => byte !== 0),
    "zero WAL tx",
  );
  assert(
    projectUuid.some((byte) => byte !== 0),
    "zero WAL project UUID",
  );
  assert(
    nonce.some((byte) => byte !== 0),
    "zero WAL nonce",
  );
  assert(
    activeName.equals(Buffer.from(ACTIVE_NAME)),
    "WAL active name mismatch",
  );
  assert(
    stageName.equals(Buffer.from(`${STAGE_PREFIX}${tx.toString("hex")}`)),
    "WAL stage name mismatch",
  );
  return {
    tx: tx.toString("hex"),
    project_uuid: projectUuid.toString("hex"),
    nonce: nonce.toString("hex"),
    generation: generation.toString(),
    marker_digest: markerDigest.toString("hex"),
    root_path_digest: rootPathDigest.toString("hex"),
    project_leaf: projectLeaf.toString("utf8"),
    active_digest: activeDigest.toString("hex"),
    stage_digest: stageDigest.toString("hex"),
    hash: sha256(bytes).toString("hex"),
  };
}

async function parseWal(path) {
  const bytes = await readFile(path);
  let offset = 0;
  let previous = Buffer.alloc(32);
  const phases = [];
  let binding = null;
  let bindingHash = null;
  while (offset < bytes.length) {
    assert(offset + 72 <= bytes.length, "truncated WAL record envelope");
    const length = bytes.readUInt32BE(offset);
    const checksum = bytes.readUInt32BE(offset + 4);
    const predecessor = bytes.subarray(offset + 8, offset + 40);
    assert(predecessor.equals(previous), "WAL predecessor mismatch");
    const payloadStart = offset + 40;
    const payloadEnd = payloadStart + length;
    const hashEnd = payloadEnd + 32;
    assert(hashEnd <= bytes.length, "truncated WAL record payload");
    const payload = bytes.subarray(payloadStart, payloadEnd);
    const storedHash = bytes.subarray(payloadEnd, hashEnd);
    assert.equal(crc32(payload), checksum, "WAL CRC mismatch");
    const calculated = sha256(
      Buffer.from("CCSW-WAL-RECORD-V1\0", "ascii"),
      predecessor,
      u32(length),
      u32(checksum),
      payload,
    );
    assert(storedHash.equals(calculated), "WAL record hash mismatch");
    assert(payload.length >= 1, "empty WAL phase payload");
    const phase = payload[0];
    const expectedPhase = phases.length + 1;
    assert.equal(phase, expectedPhase, "WAL phase order mismatch");
    if (phase === 1) {
      assert(payload.length >= 5, "truncated PREPARED payload");
      const bindingLength = payload.readUInt32BE(1);
      assert.equal(
        payload.length,
        5 + bindingLength,
        "PREPARED binding length mismatch",
      );
      const bindingBytes = payload.subarray(5);
      binding = decodeWalBinding(bindingBytes);
      bindingHash = sha256(bindingBytes);
    } else {
      assert(phase === 2 || phase === 3, "unknown WAL phase");
      assert(bindingHash, "WAL phase precedes PREPARED binding");
      assert.equal(
        payload.length,
        33,
        "WAL phase binding hash length mismatch",
      );
      assert(
        payload.subarray(1).equals(bindingHash),
        "WAL phase binding hash mismatch",
      );
    }
    phases.push(phase);
    previous = Buffer.from(storedHash);
    offset = hashEnd;
  }
  assert.equal(offset, bytes.length, "trailing WAL bytes");
  assert(binding, "WAL lacks PREPARED binding");
  return {
    phases,
    bytes: bytes.length,
    chainHead: previous.toString("hex"),
    binding,
  };
}

async function beginBarrierSwap(
  helper,
  barrierLauncher,
  fixture,
  point,
  label,
) {
  const session = new HelperProcess(helper, fixture.caseDirectory, {
    barrierLauncher,
  });
  try {
    const sessionDigest = await session.probe(label);
    await session.sendOperation(swapBody(sessionDigest, fixture, point));
    await session.readBarrier(point, fixture.tx);
    return session;
  } catch (error) {
    await session.dispose();
    throw error;
  }
}

async function recoverAndAssert(helper, fixture, expected, label) {
  const response = await transact(
    helper,
    fixture.caseDirectory,
    label,
    (session) => ({
      opcode: OP_RECOVER_FORWARD,
      body: recoverBody(session, fixture),
    }),
  );
  await expectStatus(response, 0, label);
  assert.equal(response.payload.length, 24, "recover payload length mismatch");
  assert(
    response.payload.subarray(0, 16).equals(fixture.tx),
    "recover tx mismatch",
  );
  assert.equal(
    response.payload.readBigUInt64BE(16),
    fixture.generation,
    "recover generation mismatch",
  );
  await assertMapping(fixture, expected, "post");
  const wal = await parseWal(fixture.walPath);
  assert.deepEqual(wal.phases, [1, 2, 3], "recovery did not commit the WAL");
  return wal;
}

async function runRawFirstFrameCase(
  helper,
  caseContext,
  raw,
  expectedOpcode,
  expectedStatus,
) {
  const processHandle = new HelperProcess(helper, caseContext.caseDirectory);
  try {
    await processHandle.sendRaw(raw, { end: true });
    const response = await processHandle.readResponse(expectedOpcode);
    await expectStatus(response, expectedStatus, caseContext.name);
    const exit = await processHandle.wait();
    assertExitForResponse(
      exit,
      response,
      processHandle.stderr.toString("utf8"),
    );
    return { status: response.status, message: response.message };
  } finally {
    await processHandle.dispose();
  }
}

async function runProbeFailureCase(
  helper,
  caseContext,
  body,
  expectedOpcode = OP_PROBE,
) {
  const processHandle = new HelperProcess(helper, caseContext.caseDirectory);
  try {
    await processHandle.sendBody(body, { end: true });
    const response = await processHandle.readResponse(expectedOpcode);
    await expectStatus(response, STATUS_PROTOCOL, caseContext.name);
    const exit = await processHandle.wait();
    assertExitForResponse(
      exit,
      response,
      processHandle.stderr.toString("utf8"),
    );
    return { status: response.status, message: response.message };
  } finally {
    await processHandle.dispose();
  }
}

async function runOperationFailureCase(
  helper,
  caseContext,
  buildBody,
  expectedStatus,
) {
  const response = await transact(
    helper,
    caseContext.caseDirectory,
    caseContext.name,
    (session) => buildBody(session),
  );
  await expectStatus(response, expectedStatus, caseContext.name);
  return { status: response.status, message: response.message };
}

async function runSuite({
  normalHelper,
  syntheticHelper,
  barrierLauncher,
  runRoot,
}) {
  const results = [];
  let caseNumber = 0;

  async function runCase(name, callback) {
    caseNumber += 1;
    const caseDirectory = join(
      runRoot,
      `${String(caseNumber).padStart(2, "0")}-${name}`,
    );
    await mkdirSecure(caseDirectory, runRoot);
    await writeExclusive(
      join(caseDirectory, "SYNTHETIC-ONLY.json"),
      Buffer.from(
        `${JSON.stringify({
          schema_version: "creatorcut-secure-swap-synthetic-case/1.0",
          case: name,
          retained: true,
        })}\n`,
        "utf8",
      ),
      runRoot,
    );
    const context = { name, caseDirectory, runRoot };
    const startedAt = new Date().toISOString();
    let result;
    try {
      const details = await callback(context);
      result = { name, status: "passed", started_at: startedAt, details };
    } catch (error) {
      result = {
        name,
        status: "failed",
        started_at: startedAt,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      };
    }
    result.finished_at = new Date().toISOString();
    await writeExclusive(
      join(caseDirectory, "case-evidence.json"),
      Buffer.from(`${JSON.stringify(result, null, 2)}\n`, "utf8"),
      runRoot,
    );
    await appendFile(
      join(runRoot, "results.jsonl"),
      `${JSON.stringify(result)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    results.push(result);
  }

  await runCase("protocol-short-frame", async (context) => {
    const raw = Buffer.concat([u32(7), Buffer.alloc(7)]);
    return runRawFirstFrameCase(normalHelper, context, raw, 0, STATUS_PROTOCOL);
  });

  await runCase("protocol-oversize-frame", async (context) => {
    return runRawFirstFrameCase(
      normalHelper,
      context,
      u32(MAX_FRAME + 1),
      0,
      STATUS_PROTOCOL,
    );
  });

  await runCase("protocol-truncated-frame", async (context) => {
    const raw = Buffer.concat([u32(8), Buffer.from("CCSW")]);
    return runRawFirstFrameCase(normalHelper, context, raw, 0, STATUS_PROTOCOL);
  });

  await runCase("probe-zero-challenge", async (context) => {
    return runProbeFailureCase(
      normalHelper,
      context,
      probeBody(Buffer.alloc(32)),
    );
  });

  await runCase("probe-trailing-data", async (context) => {
    return runProbeFailureCase(
      normalHelper,
      context,
      probeBody(deriveBytes(`${context.name}:challenge`, 32), Buffer.from([1])),
    );
  });

  await runCase("probe-must-be-first", async (context) => {
    return runProbeFailureCase(
      normalHelper,
      context,
      requestBody(OP_CAPABILITIES),
      OP_PROBE,
    );
  });

  for (const [buildName, helper] of [
    ["normal", normalHelper],
    ["synthetic", syntheticHelper],
  ]) {
    await runCase(`${buildName}-probe-capabilities`, async (context) => {
      const root = join(context.caseDirectory, "capability-root");
      await mkdirSecure(root, runRoot);
      const sentinel = join(
        context.caseDirectory,
        "outside-capability-sentinel.bin",
      );
      await writeExclusive(
        sentinel,
        deriveBytes(`${context.name}:sentinel`, 32),
        runRoot,
      );
      const sentinelBefore = await treeManifest(sentinel);
      const response = await transact(
        helper,
        context.caseDirectory,
        context.name,
        (session) => ({
          opcode: OP_CAPABILITIES,
          body: capabilitiesBody(session, root),
        }),
      );
      await expectStatus(response, 0, context.name);
      assert.equal(
        response.payload.length,
        40,
        "capabilities payload length mismatch",
      );
      const bits = response.payload.readUInt32BE(0);
      assert.equal(bits & (CAP_SWAP | CAP_FLOCK), CAP_SWAP | CAP_FLOCK);
      assert.equal(response.payload.readUInt16BE(4), PROTOCOL_SCHEMA);
      assert.equal(response.payload.readUInt16BE(6), DIGEST_SCHEMA);
      assert(response.payload.subarray(8).equals(BUILD_ID));
      assert.deepEqual(await treeManifest(sentinel), sentinelBefore);
      return { bits, build_id: response.payload.subarray(8).toString("ascii") };
    });
  }

  await runCase("operation-unknown-opcode", async (context) => {
    return runOperationFailureCase(
      normalHelper,
      context,
      (session) => ({ opcode: 0x7f, body: requestBody(0x7f, session) }),
      STATUS_PROTOCOL,
    );
  });

  await runCase("operation-wrong-session", async (context) => {
    const root = join(context.caseDirectory, "wrong-session-root");
    await mkdirSecure(root, runRoot);
    return runOperationFailureCase(
      normalHelper,
      context,
      () => ({
        opcode: OP_CAPABILITIES,
        body: capabilitiesBody(deriveBytes(`${context.name}:wrong`, 32), root),
      }),
      STATUS_PROTOCOL,
    );
  });

  for (const operation of ["swap", "recover"]) {
    await runCase(`normal-${operation}-unsupported`, async (context) => {
      const fixture = await createFixture(context);
      const before = await initialMapping(fixture);
      const response = await transact(
        normalHelper,
        context.caseDirectory,
        context.name,
        (session) => ({
          opcode: operation === "swap" ? OP_SWAP_FORWARD : OP_RECOVER_FORWARD,
          body:
            operation === "swap"
              ? swapBody(session, fixture)
              : recoverBody(session, fixture),
        }),
      );
      await expectStatus(response, STATUS_UNSUPPORTED, context.name);
      await assertMapping(fixture, before, "pre");
      assert.deepEqual(await readdir(fixture.walDirectory), []);
      return { status: response.status, message: response.message };
    });
  }

  await runCase("synthetic-happy-repeated-enumeration", async (context) => {
    const fixture = await createFixture(context);
    const before = await initialMapping(fixture);
    const response = await transact(
      syntheticHelper,
      context.caseDirectory,
      context.name,
      (session) => ({
        opcode: OP_SWAP_FORWARD,
        body: swapBody(session, fixture),
      }),
    );
    await expectStatus(response, 0, context.name);
    assert.equal(response.payload.length, 88, "swap payload length mismatch");
    assert(
      response.payload.subarray(0, 16).equals(fixture.tx),
      "swap tx mismatch",
    );
    assert.equal(response.payload.readBigUInt64BE(16), fixture.generation);
    await assertMapping(fixture, before, "post");
    const walBeforeRecovery = await parseWal(fixture.walPath);
    assert.deepEqual(walBeforeRecovery.phases, [1, 2, 3]);
    const walAfterRecovery = await recoverAndAssert(
      syntheticHelper,
      fixture,
      before,
      `${context.name}:committed-recovery`,
    );
    return { wal_before: walBeforeRecovery, wal_after: walAfterRecovery };
  });

  for (const barrier of BARRIERS) {
    await runCase(`crash-${barrier.name}`, async (context) => {
      const fixture = await createFixture(context);
      const before = await initialMapping(fixture);
      const processHandle = await beginBarrierSwap(
        syntheticHelper,
        barrierLauncher,
        fixture,
        barrier.point,
        context.name,
      );
      try {
        const exit = await processHandle.kill("SIGKILL");
        assert.equal(exit.signal, "SIGKILL", "barrier helper was not killed");
      } finally {
        await processHandle.dispose();
      }
      await assertMapping(fixture, before, barrier.mapping);
      const crashWal = await parseWal(fixture.walPath);
      assert.deepEqual(
        crashWal.phases,
        barrier.phases,
        "crash WAL phase mismatch",
      );
      const recoveredWal = await recoverAndAssert(
        syntheticHelper,
        fixture,
        before,
        `${context.name}:recover`,
      );
      return {
        crash_mapping: barrier.mapping,
        crash_wal: crashWal,
        recovered_wal: recoveredWal,
      };
    });
  }

  await runCase("committed-response-loss", async (context) => {
    const fixture = await createFixture(context);
    const before = await initialMapping(fixture);
    const processHandle = await beginBarrierSwap(
      syntheticHelper,
      barrierLauncher,
      fixture,
      BARRIER_AFTER_COMMITTED,
      context.name,
    );
    try {
      const stdoutClosed = once(processHandle.child.stdout, "close");
      processHandle.child.stdout.destroy();
      await stdoutClosed;
      await processHandle.acknowledgeBarrier(BARRIER_AFTER_COMMITTED);
      const exit = await processHandle.wait();
      assert.notDeepEqual(
        exit,
        { code: 0, signal: null },
        "helper reported success after its final response channel was closed",
      );
      await assertMapping(fixture, before, "post");
      const recoveredWal = await recoverAndAssert(
        syntheticHelper,
        fixture,
        before,
        `${context.name}:recover`,
      );
      return { lost_response_exit: exit, recovered_wal: recoveredWal };
    } finally {
      await processHandle.dispose();
    }
  });

  for (const malformed of ["empty", "torn", "bad-checksum"]) {
    await runCase(`wal-${malformed}`, async (context) => {
      const fixture = await createFixture(context);
      const before = await initialMapping(fixture);
      let bytes;
      if (malformed === "empty") {
        bytes = Buffer.alloc(0);
      } else if (malformed === "torn") {
        bytes = Buffer.concat([u32(64), Buffer.alloc(11, 0x5a)]);
      } else {
        const payload = Buffer.from([1]);
        bytes = Buffer.concat([
          u32(payload.length),
          u32(0),
          Buffer.alloc(32),
          payload,
          Buffer.alloc(32),
        ]);
      }
      await writeExclusive(fixture.walPath, bytes, runRoot);
      const response = await transact(
        syntheticHelper,
        context.caseDirectory,
        context.name,
        (session) => ({
          opcode: OP_RECOVER_FORWARD,
          body: recoverBody(session, fixture),
        }),
      );
      await expectStatus(response, STATUS_WAL, context.name);
      await assertMapping(fixture, before, "pre");
      assert(
        (await readFile(fixture.walPath)).equals(bytes),
        "malformed WAL changed",
      );
      return { status: response.status, retained_bytes: bytes.length };
    });
  }

  await runCase("recovery-third-mapping", async (context) => {
    const fixture = await createFixture(context);
    const before = await initialMapping(fixture);
    const processHandle = await beginBarrierSwap(
      syntheticHelper,
      barrierLauncher,
      fixture,
      BARRIER_AFTER_PREPARED,
      context.name,
    );
    try {
      await processHandle.kill("SIGKILL");
    } finally {
      await processHandle.dispose();
    }
    const retainedActive = join(fixture.evidenceDirectory, "bound-active-tree");
    await rename(fixture.active, retainedActive);
    await createActive(fixture.active, runRoot, `${context.name}:third`);
    const thirdManifest = await treeManifest(fixture.active);
    const response = await transact(
      syntheticHelper,
      context.caseDirectory,
      `${context.name}:recover`,
      (session) => ({
        opcode: OP_RECOVER_FORWARD,
        body: recoverBody(session, fixture),
      }),
    );
    await expectStatus(response, STATUS_CONFLICT, context.name);
    assert.deepEqual(await treeManifest(retainedActive), before.active);
    assert.deepEqual(await treeManifest(fixture.active), thirdManifest);
    assert.deepEqual(await treeManifest(fixture.stage), before.stage);
    await assertSentinel(fixture, before.sentinel);
    return { status: response.status, wal: await parseWal(fixture.walPath) };
  });

  await runCase("swapped-wal-with-pre-mapping", async (context) => {
    const fixture = await createFixture(context);
    const before = await initialMapping(fixture);
    const processHandle = await beginBarrierSwap(
      syntheticHelper,
      barrierLauncher,
      fixture,
      BARRIER_AFTER_SWAPPED,
      context.name,
    );
    try {
      await processHandle.kill("SIGKILL");
    } finally {
      await processHandle.dispose();
    }
    await assertMapping(fixture, before, "post");
    const crashWal = await parseWal(fixture.walPath);
    assert.deepEqual(crashWal.phases, [1, 2]);

    const retainedPublic = join(
      fixture.projectRoot,
      ".retained-public-mapping-tree",
    );
    await rename(fixture.active, retainedPublic);
    await rename(fixture.stage, fixture.active);
    await rename(retainedPublic, fixture.stage);
    await assertMapping(fixture, before, "pre");

    const response = await transact(
      syntheticHelper,
      context.caseDirectory,
      `${context.name}:recover`,
      (session) => ({
        opcode: OP_RECOVER_FORWARD,
        body: recoverBody(session, fixture),
      }),
    );
    await expectStatus(response, STATUS_CONFLICT, context.name);
    await assertMapping(fixture, before, "pre");
    const retainedWal = await parseWal(fixture.walPath);
    assert.deepEqual(retainedWal.phases, [1, 2]);
    return { status: response.status, wal: retainedWal };
  });

  await runCase("unknown-stage-namespace", async (context) => {
    const fixture = await createFixture(context);
    const before = await initialMapping(fixture);
    const unknown = join(
      fixture.projectRoot,
      `${STAGE_PREFIX}${"f".repeat(32)}`,
    );
    assert.notEqual(basename(unknown), fixture.stageName);
    await mkdirSecure(unknown, runRoot);
    await writeExclusive(
      join(unknown, "retained.txt"),
      Buffer.from("unknown-stage\n"),
      runRoot,
    );
    const response = await transact(
      syntheticHelper,
      context.caseDirectory,
      context.name,
      (session) => ({
        opcode: OP_SWAP_FORWARD,
        body: swapBody(session, fixture),
      }),
    );
    await expectStatus(response, STATUS_CONFLICT, context.name);
    await assertMapping(fixture, before, "pre");
    assert.deepEqual(await readdir(fixture.walDirectory), []);
    return { status: response.status, unknown_stage: basename(unknown) };
  });

  for (const objectType of ["symlink", "hardlink", "fifo"]) {
    await runCase(`stage-rejects-${objectType}`, async (context) => {
      const fixture = await createFixture(context);
      const projectFile = join(fixture.stage, "project.json");
      const retained = join(fixture.evidenceDirectory, "original-project.json");
      await rename(projectFile, retained);
      if (objectType === "symlink") {
        await symlink(fixture.sentinel, projectFile);
      } else if (objectType === "hardlink") {
        await link(retained, projectFile);
      } else {
        assertInside(runRoot, projectFile);
        await execFileAsync("/usr/bin/mkfifo", [projectFile], {
          cwd: context.caseDirectory,
          env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
          timeout: PROCESS_TIMEOUT_MS,
        });
        await chmod(projectFile, 0o600);
      }
      const before = await initialMapping(fixture);
      const response = await transact(
        syntheticHelper,
        context.caseDirectory,
        context.name,
        (session) => ({
          opcode: OP_SWAP_FORWARD,
          body: swapBody(session, fixture),
        }),
      );
      await expectStatus(response, STATUS_UNSAFE_OBJECT, context.name);
      await assertMapping(fixture, before, "pre");
      assert.deepEqual(await readdir(fixture.walDirectory), []);
      return { status: response.status, object_type: objectType };
    });
  }

  for (const metadataType of ["xattr", "acl"]) {
    await runCase(`stage-rejects-${metadataType}`, async (context) => {
      const fixture = await createFixture(context);
      const projectFile = join(fixture.stage, "project.json");
      if (metadataType === "xattr") {
        await execFileAsync(
          "/usr/bin/xattr",
          ["-w", "com.creatorcut.synthetic-test", "retained", projectFile],
          {
            cwd: context.caseDirectory,
            env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
            timeout: PROCESS_TIMEOUT_MS,
          },
        );
      } else {
        await execFileAsync(
          "/bin/chmod",
          ["+a", "everyone allow readattr", projectFile],
          {
            cwd: context.caseDirectory,
            env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
            timeout: PROCESS_TIMEOUT_MS,
          },
        );
      }
      const inspectArguments =
        metadataType === "xattr"
          ? ["-px", "com.creatorcut.synthetic-test", projectFile]
          : ["-lde", projectFile];
      const inspectExecutable =
        metadataType === "xattr" ? "/usr/bin/xattr" : "/bin/ls";
      const metadataBefore = await execFileAsync(
        inspectExecutable,
        inspectArguments,
        {
          cwd: context.caseDirectory,
          env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
          timeout: PROCESS_TIMEOUT_MS,
        },
      );
      assert(
        metadataBefore.stdout.length > 0,
        `${metadataType} fixture was not observable`,
      );
      const before = await initialMapping(fixture);
      const response = await transact(
        syntheticHelper,
        context.caseDirectory,
        context.name,
        (session) => ({
          opcode: OP_SWAP_FORWARD,
          body: swapBody(session, fixture),
        }),
      );
      await expectStatus(response, STATUS_UNSAFE_OBJECT, context.name);
      await assertMapping(fixture, before, "pre");
      assert.deepEqual(await readdir(fixture.walDirectory), []);
      const metadataAfter = await execFileAsync(
        inspectExecutable,
        inspectArguments,
        {
          cwd: context.caseDirectory,
          env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
          timeout: PROCESS_TIMEOUT_MS,
        },
      );
      assert.equal(
        metadataAfter.stdout,
        metadataBefore.stdout,
        `${metadataType} metadata changed`,
      );
      return {
        status: response.status,
        metadata_type: metadataType,
        metadata_sha256: sha256(Buffer.from(metadataAfter.stdout)).toString(
          "hex",
        ),
      };
    });
  }

  await runCase("root-ancestor-symlink-rejected", async (context) => {
    const fixture = await createFixture(context, {
      containerName: "real-parent",
    });
    const before = await initialMapping(fixture);
    const aliasParent = join(context.caseDirectory, "alias-parent");
    await symlink("real-parent", aliasParent);
    const aliasRoot = join(aliasParent, "project");
    const response = await transact(
      syntheticHelper,
      context.caseDirectory,
      context.name,
      (session) => ({
        opcode: OP_SWAP_FORWARD,
        body: swapBody(session, fixture, 0, aliasRoot),
      }),
    );
    await expectStatus(
      response,
      [
        STATUS_INVALID_REQUEST,
        STATUS_IO,
        STATUS_UNSAFE_OBJECT,
        STATUS_CONFLICT,
      ],
      context.name,
    );
    await assertMapping(fixture, before, "pre");
    assert.deepEqual(await readdir(fixture.walDirectory), []);
    return { status: response.status, alias: relative(runRoot, aliasRoot) };
  });

  await runCase("project-root-replacement-at-prepared", async (context) => {
    const fixture = await createFixture(context);
    const before = await initialMapping(fixture);
    const processHandle = await beginBarrierSwap(
      syntheticHelper,
      barrierLauncher,
      fixture,
      BARRIER_AFTER_PREPARED,
      context.name,
    );
    try {
      const retainedRoot = join(
        context.caseDirectory,
        "retained-original-project",
      );
      await rename(fixture.projectRoot, retainedRoot);
      await mkdirSecure(fixture.projectRoot, runRoot);
      await writeExclusive(
        join(fixture.projectRoot, "replacement-sentinel.txt"),
        Buffer.from("replacement-root-must-remain-untouched\n", "utf8"),
        runRoot,
      );
      const replacementBefore = await treeManifest(fixture.projectRoot);
      await processHandle.acknowledgeBarrier(BARRIER_AFTER_PREPARED);
      const response = await processHandle.readResponse(OP_SWAP_FORWARD);
      await expectStatus(response, STATUS_RECOVERY_REQUIRED, context.name);
      const exit = await processHandle.wait();
      assertExitForResponse(
        exit,
        response,
        processHandle.stderr.toString("utf8"),
      );
      const retainedFixture = {
        ...fixture,
        projectRoot: retainedRoot,
        active: join(retainedRoot, ACTIVE_NAME),
        stage: join(retainedRoot, fixture.stageName),
        walDirectory: join(retainedRoot, CONTROL_NAME, WAL_DIRECTORY_NAME),
        walPath: join(
          retainedRoot,
          CONTROL_NAME,
          WAL_DIRECTORY_NAME,
          `${fixture.tx.toString("hex")}.wal`,
        ),
      };
      await assertMapping(retainedFixture, before, "pre");
      assert.deepEqual(
        await treeManifest(fixture.projectRoot),
        replacementBefore,
      );
      const retainedWal = await parseWal(retainedFixture.walPath);
      assert.deepEqual(retainedWal.phases, [1]);
      return { status: response.status, retained_wal: retainedWal };
    } finally {
      await processHandle.dispose();
    }
  });

  await runCase("project-parent-move-at-prepared", async (context) => {
    const fixture = await createFixture(context, {
      containerName: "movable-parent",
    });
    const before = await initialMapping(fixture);
    const processHandle = await beginBarrierSwap(
      syntheticHelper,
      barrierLauncher,
      fixture,
      BARRIER_AFTER_PREPARED,
      context.name,
    );
    try {
      const originalParent = dirname(fixture.projectRoot);
      const retainedParent = join(
        context.caseDirectory,
        "retained-original-parent",
      );
      await rename(originalParent, retainedParent);
      await mkdirSecure(originalParent, runRoot);
      const replacementRoot = join(originalParent, "project");
      await mkdirSecure(replacementRoot, runRoot);
      await writeExclusive(
        join(replacementRoot, "replacement-parent-sentinel.txt"),
        Buffer.from("replacement-parent-must-remain-untouched\n", "utf8"),
        runRoot,
      );
      const replacementBefore = await treeManifest(replacementRoot);
      await processHandle.acknowledgeBarrier(BARRIER_AFTER_PREPARED);
      const response = await processHandle.readResponse(OP_SWAP_FORWARD);
      await expectStatus(response, STATUS_RECOVERY_REQUIRED, context.name);
      const exit = await processHandle.wait();
      assertExitForResponse(
        exit,
        response,
        processHandle.stderr.toString("utf8"),
      );
      const retainedRoot = join(retainedParent, "project");
      const retainedFixture = {
        ...fixture,
        projectRoot: retainedRoot,
        active: join(retainedRoot, ACTIVE_NAME),
        stage: join(retainedRoot, fixture.stageName),
        walDirectory: join(retainedRoot, CONTROL_NAME, WAL_DIRECTORY_NAME),
        walPath: join(
          retainedRoot,
          CONTROL_NAME,
          WAL_DIRECTORY_NAME,
          `${fixture.tx.toString("hex")}.wal`,
        ),
      };
      await assertMapping(retainedFixture, before, "pre");
      assert.deepEqual(await treeManifest(replacementRoot), replacementBefore);
      const retainedWal = await parseWal(retainedFixture.walPath);
      assert.deepEqual(retainedWal.phases, [1]);
      return { status: response.status, retained_wal: retainedWal };
    } finally {
      await processHandle.dispose();
    }
  });

  await runCase("stage-xattr-mutation-at-prepared", async (context) => {
    const fixture = await createFixture(context);
    const before = await initialMapping(fixture);
    const processHandle = await beginBarrierSwap(
      syntheticHelper,
      barrierLauncher,
      fixture,
      BARRIER_AFTER_PREPARED,
      context.name,
    );
    try {
      const projectFile = join(fixture.stage, "project.json");
      await execFileAsync(
        "/usr/bin/xattr",
        ["-w", "com.creatorcut.after-prepared", "retained", projectFile],
        {
          cwd: context.caseDirectory,
          env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
          timeout: PROCESS_TIMEOUT_MS,
        },
      );
      const xattrBefore = await execFileAsync(
        "/usr/bin/xattr",
        ["-px", "com.creatorcut.after-prepared", projectFile],
        {
          cwd: context.caseDirectory,
          env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
          timeout: PROCESS_TIMEOUT_MS,
        },
      );
      await processHandle.acknowledgeBarrier(BARRIER_AFTER_PREPARED);
      const response = await processHandle.readResponse(OP_SWAP_FORWARD);
      await expectStatus(response, STATUS_RECOVERY_REQUIRED, context.name);
      const exit = await processHandle.wait();
      assertExitForResponse(
        exit,
        response,
        processHandle.stderr.toString("utf8"),
      );
      await assertMapping(fixture, before, "pre");
      const xattrAfter = await execFileAsync(
        "/usr/bin/xattr",
        ["-px", "com.creatorcut.after-prepared", projectFile],
        {
          cwd: context.caseDirectory,
          env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
          timeout: PROCESS_TIMEOUT_MS,
        },
      );
      assert.equal(
        xattrAfter.stdout,
        xattrBefore.stdout,
        "barrier xattr was changed",
      );
      const retainedWal = await parseWal(fixture.walPath);
      assert.deepEqual(retainedWal.phases, [1]);
      return { status: response.status, retained_wal: retainedWal };
    } finally {
      await processHandle.dispose();
    }
  });

  await runCase("wal-replacement-at-prepared", async (context) => {
    const fixture = await createFixture(context);
    const before = await initialMapping(fixture);
    const processHandle = await beginBarrierSwap(
      syntheticHelper,
      barrierLauncher,
      fixture,
      BARRIER_AFTER_PREPARED,
      context.name,
    );
    try {
      const retainedWal = join(
        fixture.evidenceDirectory,
        "original-prepared.wal",
      );
      await rename(fixture.walPath, retainedWal);
      await copyFile(retainedWal, fixture.walPath, fsConstants.COPYFILE_EXCL);
      await chmod(fixture.walPath, 0o600);
      await processHandle.acknowledgeBarrier(BARRIER_AFTER_PREPARED);
      const response = await processHandle.readResponse(OP_SWAP_FORWARD);
      await expectStatus(response, STATUS_RECOVERY_REQUIRED, context.name);
      const exit = await processHandle.wait();
      assertExitForResponse(
        exit,
        response,
        processHandle.stderr.toString("utf8"),
      );
      await assertMapping(fixture, before, "pre");
      assert(
        (await readFile(retainedWal)).equals(await readFile(fixture.walPath)),
      );
      return {
        status: response.status,
        retained_wal: relative(runRoot, retainedWal),
      };
    } finally {
      await processHandle.dispose();
    }
  });

  await runCase("stage-replacement-at-prepared", async (context) => {
    const fixture = await createFixture(context);
    const before = await initialMapping(fixture);
    const processHandle = await beginBarrierSwap(
      syntheticHelper,
      barrierLauncher,
      fixture,
      BARRIER_AFTER_PREPARED,
      context.name,
    );
    try {
      const retainedStage = join(
        fixture.evidenceDirectory,
        "original-public-stage",
      );
      await rename(fixture.stage, retainedStage);
      await createStage(
        fixture.stage,
        runRoot,
        fixture.name,
        fixture.projectUuid,
        fixture.generation,
      );
      await processHandle.acknowledgeBarrier(BARRIER_AFTER_PREPARED);
      const response = await processHandle.readResponse(OP_SWAP_FORWARD);
      await expectStatus(response, STATUS_RECOVERY_REQUIRED, context.name);
      const exit = await processHandle.wait();
      assertExitForResponse(
        exit,
        response,
        processHandle.stderr.toString("utf8"),
      );
      assert.deepEqual(await treeManifest(fixture.active), before.active);
      assert.deepEqual(await treeManifest(retainedStage), before.stage);
      await assertSentinel(fixture, before.sentinel);
      return {
        status: response.status,
        retained_stage: relative(runRoot, retainedStage),
      };
    } finally {
      await processHandle.dispose();
    }
  });

  await runCase("stable-lock-contention", async (context) => {
    const fixture = await createFixture(context);
    const before = await initialMapping(fixture);
    const holder = await beginBarrierSwap(
      syntheticHelper,
      barrierLauncher,
      fixture,
      BARRIER_AFTER_PREPARED,
      `${context.name}:holder`,
    );
    const contender = new HelperProcess(syntheticHelper, context.caseDirectory);
    try {
      const contenderSession = await contender.probe(
        `${context.name}:contender`,
      );
      await contender.sendOperation(recoverBody(contenderSession, fixture));
      const response = await contender.readResponse(OP_RECOVER_FORWARD);
      await expectStatus(response, STATUS_CONFLICT, context.name);
      const contenderExit = await contender.wait();
      assertExitForResponse(
        contenderExit,
        response,
        contender.stderr.toString("utf8"),
      );
      const holderExit = await holder.kill("SIGKILL");
      assert.equal(holderExit.signal, "SIGKILL");
    } finally {
      await contender.dispose();
      await holder.dispose();
    }
    await assertMapping(fixture, before, "pre");
    const recoveredWal = await recoverAndAssert(
      syntheticHelper,
      fixture,
      before,
      `${context.name}:recover`,
    );
    return { contender_status: STATUS_CONFLICT, recovered_wal: recoveredWal };
  });

  return results;
}

async function main() {
  assert.equal(
    process.platform,
    "darwin",
    "secure-swap harness is Darwin-only",
  );
  assert.equal(
    process.versions.node.split(".")[0],
    "24",
    "secure-swap harness requires Node 24",
  );
  const args = parseArguments(process.argv.slice(2));
  if (!args) return;
  const tempRoot = await validateTempRoot(args.tempRoot);
  const normalHelper = await validateHelper(args.normalHelper, "normal helper");
  const syntheticHelper = await validateHelper(
    args.syntheticHelper,
    "synthetic helper",
  );
  const barrierLauncher = await validateHelper(
    args.barrierLauncher,
    "barrier launcher",
  );
  assert.notEqual(
    normalHelper,
    syntheticHelper,
    "normal and synthetic helpers must be distinct files",
  );
  assert.notEqual(
    barrierLauncher,
    normalHelper,
    "barrier launcher must be a distinct file",
  );
  assert.notEqual(
    barrierLauncher,
    syntheticHelper,
    "barrier launcher must be a distinct file",
  );
  const [normalStat, syntheticStat, launcherStat] = await Promise.all([
    lstat(normalHelper, { bigint: true }),
    lstat(syntheticHelper, { bigint: true }),
    lstat(barrierLauncher, { bigint: true }),
  ]);
  assert(
    normalStat.dev !== syntheticStat.dev ||
      normalStat.ino !== syntheticStat.ino,
    "normal and synthetic helpers must not be hard links to the same file",
  );
  assert(
    (launcherStat.dev !== normalStat.dev ||
      launcherStat.ino !== normalStat.ino) &&
      (launcherStat.dev !== syntheticStat.dev ||
        launcherStat.ino !== syntheticStat.ino),
    "barrier launcher must not be a hard link to either helper",
  );

  const runName = `secure-swap-harness-${Date.now()}-${randomBytes(16).toString("hex")}`;
  const runRoot = join(tempRoot, runName);
  assertInside(tempRoot, runRoot);
  await mkdir(runRoot, { mode: 0o700 });
  await chmod(runRoot, 0o700);
  const candidate = await retainCandidateArtifacts(runRoot, {
    normalHelper,
    syntheticHelper,
    barrierLauncher,
  });
  await writeExclusive(
    join(runRoot, "OWNER-MARKER.json"),
    Buffer.from(
      `${JSON.stringify(
        {
          schema_version: "creatorcut-secure-swap-harness/1.0",
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
          protocol_schema: PROTOCOL_SCHEMA,
          digest_schema: DIGEST_SCHEMA,
          wal_schema: WAL_SCHEMA,
          build_id: BUILD_ID.toString("ascii"),
          candidate_digest: candidate.digest,
          candidate_artifacts: candidate.records,
          helper_barrier_fd: BARRIER_FD,
          created_at: new Date().toISOString(),
          deletion_policy: "retain-all",
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    runRoot,
  );

  const results = await runSuite({
    normalHelper: candidate.normalHelper,
    syntheticHelper: candidate.syntheticHelper,
    barrierLauncher: candidate.barrierLauncher,
    runRoot,
  });
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.length - passed;
  const summary = {
    schema_version: "creatorcut-secure-swap-harness-result/1.0",
    run_root: runRoot,
    retained: true,
    build_id: BUILD_ID.toString("ascii"),
    candidate_digest: candidate.digest,
    total: results.length,
    passed,
    failed,
    failed_cases: results
      .filter((result) => result.status === "failed")
      .map((result) => result.name),
  };
  await writeExclusive(
    join(runRoot, "SUMMARY.json"),
    Buffer.from(`${JSON.stringify(summary, null, 2)}\n`, "utf8"),
    runRoot,
  );
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (failed !== 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
