import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractRoot = join(repositoryRoot, "packages", "operations-contract");
const includedRoots = ["schemas", "vectors"];

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

async function filesUnder(directory) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const metadata = await stat(path);
    if (metadata.isDirectory()) files.push(...(await filesUnder(path)));
    else if (metadata.isFile()) files.push(path);
  }
  return files;
}

export async function operationsBundle() {
  const files = {};
  for (const rootName of includedRoots) {
    const root = join(contractRoot, rootName);
    for (const path of await filesUnder(root)) {
      const key = relative(contractRoot, path).split(sep).join("/");
      files[key] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    }
  }
  const manifest = {
    files,
    schema_version: "creatorcut-operations-bundle/1.0",
  };
  return {
    ...manifest,
    digest: `sha256:${createHash("sha256")
      .update(canonicalize(manifest))
      .digest("hex")}`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bundle = await operationsBundle();
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(bundle, null, 2)}\n`
      : `${bundle.digest}\n`,
  );
}
