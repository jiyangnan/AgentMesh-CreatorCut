import { access, writeFile } from "node:fs/promises";

import { withCreatorCutProjectLock } from "../../dist/src/project-lock.js";

const [, , state, attemptedPath, readyPath, releasePath] = process.argv;
if (!state || !attemptedPath || !readyPath || !releasePath) process.exit(2);

await writeFile(attemptedPath, "attempted", "utf8");
await withCreatorCutProjectLock(state, async () => {
  await writeFile(readyPath, "ready", "utf8");
  if (releasePath === "-") {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30_000));
    return;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (
      await access(releasePath)
        .then(() => true)
        .catch(() => false)
    )
      return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("Timed out waiting for current-lock release");
});
