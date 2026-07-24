import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protocolRoot = join(repositoryRoot, "packages", "protocol");
const excluded = new Set(["node_modules", "dist", "coverage", ".DS_Store"]);

async function filesUnder(directory) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    if (excluded.has(name)) continue;
    const path = join(directory, name);
    const metadata = await stat(path);
    if (metadata.isDirectory()) files.push(...(await filesUnder(path)));
    else if (metadata.isFile()) files.push(path);
  }
  return files;
}

export async function protocolBundle() {
  const files = {};
  for (const path of await filesUnder(protocolRoot)) {
    const key = relative(protocolRoot, path).split(sep).join("/");
    files[key] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  const canonical = JSON.stringify(files);
  return {
    schema_version: "creatorcut-protocol-bundle/1.0",
    digest: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
    files,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bundle = await protocolBundle();
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(bundle, null, 2)}\n`
      : `${bundle.digest}\n`,
  );
}
