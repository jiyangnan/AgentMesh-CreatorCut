import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const [state, enteredPath] = process.argv.slice(2);
const lockDirectory = join(state, "project.lock");
await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
const forceEqualBirthtime =
  process.env.CREATORCUT_FROZEN_FORCE_EQUAL_BIRTHTIME === "1";
const expectedEntry = process.env.CREATORCUT_FROZEN_EXPECT_ENTRY === "1";
const holdUntilPath = process.env.CREATORCUT_FROZEN_HOLD_UNTIL;

function parseV1Owner(value) {
  try {
    const parsed = JSON.parse(value);
    return Object.keys(parsed).sort().join(",") ===
      "created_at,owner_token,pid,schema_version" &&
      parsed.schema_version === "creatorcut-project-lock/1.0" &&
      Number.isSafeInteger(parsed.pid) &&
      typeof parsed.owner_token === "string" &&
      typeof parsed.created_at === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function ownerIsAlive(owner) {
  if (!owner) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

const owner = {
  schema_version: "creatorcut-project-lock/1.0",
  pid: process.pid,
  // Frozen v1 used the raw randomUUID as both owner token and pathname.
  owner_token: process.env.CREATORCUT_FROZEN_OWNER_TOKEN ?? randomUUID(),
  created_at: new Date().toISOString(),
};
const ownPath = join(lockDirectory, `${owner.owner_token}.json`);
const handle = await open(ownPath, "wx", 0o600);
await handle.writeFile(JSON.stringify(owner), "utf8");
await handle.sync();
await handle.close();

for (let attempt = 0; attempt <= 200; attempt += 1) {
  const contenders = [];
  for (const name of await readdir(lockDirectory)) {
    const path = join(lockDirectory, name);
    const info = await stat(path, { bigint: true }).catch(() => null);
    if (!info?.isFile()) continue;
    const observed = await readFile(path, "utf8")
      .then(parseV1Owner)
      .catch(() => null);
    contenders.push({
      name,
      path,
      owner: observed,
      birthtimeNs: forceEqualBirthtime ? 0n : info.birthtimeNs,
    });
  }
  contenders.sort((left, right) =>
    left.birthtimeNs === right.birthtimeNs
      ? left.name.localeCompare(right.name)
      : left.birthtimeNs < right.birthtimeNs
        ? -1
        : 1,
  );
  for (const contender of contenders) {
    if (!ownerIsAlive(contender.owner))
      await rm(contender.path, { force: true });
  }
  const live = contenders.filter((contender) => ownerIsAlive(contender.owner));
  if (live[0]?.owner?.owner_token === owner.owner_token) {
    await writeFile(enteredPath, "entered", "utf8");
    while (holdUntilPath) {
      const released = await access(holdUntilPath)
        .then(() => true)
        .catch(() => false);
      if (released) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    await rm(ownPath, { force: true });
    process.exit(expectedEntry ? 0 : 2);
  }
  if (attempt === 200) {
    await rm(ownPath, { force: true });
    process.exit(0);
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
}
