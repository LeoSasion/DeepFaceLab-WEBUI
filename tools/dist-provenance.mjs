import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolsRoot, "..");
const webuiRoot = path.join(repositoryRoot, "webui");
const provenancePath = path.join(webuiRoot, "dist", ".build-provenance.json");
const mode = process.argv[2] ?? "check";

const inputs = [
  path.join(webuiRoot, "package.json"),
  path.join(webuiRoot, "pnpm-lock.yaml"),
  path.join(webuiRoot, "vite.config.mjs"),
  path.join(webuiRoot, ".openai", "hosting.json"),
  path.join(webuiRoot, "worker", "index.js"),
  path.join(webuiRoot, "scripts", "prepare-sites-build.mjs"),
  path.join(webuiRoot, "src"),
  path.join(webuiRoot, "shared"),
  path.join(webuiRoot, "public"),
  path.join(repositoryRoot, "release", "version.json"),
  path.join(repositoryRoot, "release", "version.mjs"),
  path.join(toolsRoot, "dist-provenance.mjs"),
];

async function filesUnder(target) {
  const info = await stat(target);
  if (info.isFile()) return [target];
  const entries = await readdir(target, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => filesUnder(path.join(target, entry.name))));
  return nested.flat();
}

async function sourceFingerprint() {
  const files = (await Promise.all(inputs.map((input) => filesUnder(input))))
    .flat()
    .sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const file of files) {
    const relative = path.relative(repositoryRoot, file).replaceAll("\\", "/");
    hash.update(relative, "utf8");
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), fileCount: files.length };
}

async function assertOutputs() {
  for (const relative of ["client/index.html", "server/index.js", ".openai/hosting.json"]) {
    const target = path.join(webuiRoot, "dist", relative);
    const info = await stat(target).catch(() => null);
    if (!info?.isFile() || info.size === 0) throw new Error(`missing build output: webui/dist/${relative}`);
  }
}

await assertOutputs();
const fingerprint = await sourceFingerprint();
if (mode === "write") {
  await mkdir(path.dirname(provenancePath), { recursive: true });
  const payload = {
    schemaVersion: 1,
    sourceSha256: fingerprint.sha256,
    sourceFileCount: fingerprint.fileCount,
    nodeMajor: Number(process.versions.node.split(".")[0]),
  };
  const temporary = `${provenancePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temporary, provenancePath);
  console.log(`build provenance written: ${payload.sourceSha256}`);
} else if (mode === "check") {
  const payload = JSON.parse(await readFile(provenancePath, "utf8"));
  if (payload.schemaVersion !== 1
      || payload.sourceSha256 !== fingerprint.sha256
      || payload.sourceFileCount !== fingerprint.fileCount) {
    throw new Error("webui/dist is stale; run the pinned production build before packaging");
  }
  console.log(`dist freshness check passed: ${fingerprint.sha256}`);
} else {
  throw new Error("usage: node tools/dist-provenance.mjs <write|check>");
}
