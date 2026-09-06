import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(path.join(root, ".paseo-sdk.json"), "utf8"));
const snapshotPath = path.join(root, config.snapshot);

function parseArgs(args) {
  const options = { mode: "update", source: process.env.PASEO_REPO };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--update" || arg === "--check") options.mode = arg.slice(2);
    else if (arg === "--source") {
      const source = args[index + 1];
      if (!source) throw new Error("--source requires a path");
      options.source = source;
      index += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function declarationFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await declarationFiles(fullPath, relative)));
    else if (entry.isFile() && entry.name.endsWith(".d.ts")) files.push({ relative, fullPath });
  }
  return files;
}

async function packageRootFromSource(source, relativePath) {
  const packageRoot = path.resolve(source, relativePath);
  if (!(await exists(path.join(packageRoot, "package.json")))) {
    throw new Error(`Paseo package not found at ${packageRoot}`);
  }
  return packageRoot;
}

async function packageRootFromInstall(packageName) {
  const segments = packageName.split("/");
  const candidates = [path.join(root, "node_modules", ...segments)];
  for (const candidatePlugin of config.plugins) {
    candidates.push(path.join(root, candidatePlugin, "node_modules", ...segments));
  }
  for (const candidate of candidates) {
    if (await exists(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`Installed package ${packageName} was not found`);
}

async function hashDeclarations(packageRoot) {
  const dist = path.join(packageRoot, "dist");
  if (!(await exists(dist))) throw new Error(`Declaration output not found at ${dist}`);
  const files = await declarationFiles(dist);
  if (files.length === 0) throw new Error(`No declarations found under ${dist}`);
  const declarations = {};
  for (const file of files.sort((left, right) => left.relative.localeCompare(right.relative))) {
    const contents = await readFile(file.fullPath);
    const relative = path.relative(packageRoot, file.fullPath).split(path.sep).join(path.posix.sep);
    declarations[relative] = createHash("sha256")
      .update(contents)
      .digest("hex");
  }
  return declarations;
}

async function buildSnapshot(source) {
  const packages = {};
  for (const [packageName, relativePath] of Object.entries(config.packages)) {
    const packageRoot = source
      ? await packageRootFromSource(source, relativePath)
      : await packageRootFromInstall(packageName);
    packages[packageName] = { declarations: await hashDeclarations(packageRoot) };
  }
  return { schemaVersion: 1, sdkVersion: config.version, packages };
}

const options = parseArgs(process.argv.slice(2));
const expected = await buildSnapshot(options.source && path.resolve(resolveHome(options.source)));

if (options.mode === "update") {
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(expected, null, 2)}\n`);
  console.log(`Updated ${path.relative(root, snapshotPath)}.`);
} else {
  if (!(await exists(snapshotPath))) throw new Error(`Missing ${path.relative(root, snapshotPath)}; run npm run sdk:snapshot first`);
  const actual = JSON.parse(await readFile(snapshotPath, "utf8"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`Paseo SDK declarations differ from ${path.relative(root, snapshotPath)}.`);
    console.error("Run npm run sdk:snapshot -- --source /path/to/paseo to review the contract update.");
    process.exitCode = 1;
  } else {
    console.log(`Paseo SDK declaration snapshot is current for ${config.version}.`);
  }
}
