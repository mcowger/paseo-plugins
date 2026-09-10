import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(path.join(root, ".paseo-sdk.json"), "utf8"));
const sdkPackages = Object.entries(config.packages);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function usage() {
  console.log(`Usage: npm run sdk:install -- [options]

Options:
  --plugin <name>       Install one plugin. Defaults to the current plugin or all plugins.
  --source <mode>       auto, online, local, or tarball. Defaults to auto.
  --paseo-repo <path>   Paseo checkout used by --source local.
  --tarball-dir <path>  Directory containing CI or release .tgz files.
  --skip-build          Reuse existing dist files in the Paseo checkout.
  --help                Show this help.
`);
}

function parseArgs(args) {
  const options = {
    plugins: [],
    source: "auto",
    paseoRepo: process.env.PASEO_REPO ?? config.localRepository,
    tarballDir: process.env.PASEO_SDK_TARBALL_DIR,
    skipBuild: process.env.PASEO_SDK_SKIP_BUILD === "1",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }
    if (["--plugin", "--source", "--paseo-repo", "--tarball-dir"].includes(arg)) {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--plugin") options.plugins.push(value);
      if (arg === "--source") options.source = value;
      if (arg === "--paseo-repo") options.paseoRepo = value;
      if (arg === "--tarball-dir") options.tarballDir = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["auto", "online", "local", "tarball"].includes(options.source)) {
    throw new Error(`Unsupported source: ${options.source}`);
  }
  return options;
}

function resolveHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function run(command, args, cwd, captureOutput = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: captureOutput ? ["ignore", "pipe", "ignore"] : "inherit",
    });
    let stdout = "";
    if (captureOutput) child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function selectedPlugins(requested) {
  if (requested.length === 0) {
    const current = path.basename(process.cwd());
    return config.plugins.includes(current) ? [current] : config.plugins;
  }
  const invalid = requested.filter((plugin) => !config.plugins.includes(plugin));
  if (invalid.length > 0) throw new Error(`Unknown plugin(s): ${invalid.join(", ")}`);
  return [...new Set(requested)];
}

async function onlinePackagesAvailable() {
  for (const [packageName] of sdkPackages) {
    try {
      await run(npmCommand, ["view", `${packageName}@${config.version}`, "version", "--json"], root, true);
    } catch {
      return false;
    }
  }
  return true;
}

function tarballPrefix(packageName) {
  return `${packageName.replace(/^@/, "").replace("/", "-")}-`;
}

async function tarballsFromDirectory(directory) {
  const files = await readdir(directory);
  const tarballs = new Map();
  for (const [packageName] of sdkPackages) {
    const candidates = files.filter(
      (file) => file.startsWith(tarballPrefix(packageName)) && file.endsWith(".tgz"),
    );
    const expected = `${tarballPrefix(packageName)}${config.version}.tgz`;
    if (!files.includes(expected)) {
      throw new Error(
        `Expected ${expected} in ${directory}; found ${candidates.length === 0 ? "none" : candidates.join(", ")}`,
      );
    }
    tarballs.set(packageName, path.join(directory, expected));
  }
  return tarballs;
}

async function packLocalPackages(paseoRepo, skipBuild) {
  const packageRoot = path.resolve(resolveHome(paseoRepo));
  if (!(await exists(path.join(packageRoot, "package.json")))) {
    throw new Error(`Paseo checkout not found at ${packageRoot}`);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-sdk-"));
  const stagingRoot = path.join(directory, "packages");
  const outputRoot = path.join(directory, "tarballs");
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  const tarballs = new Map();
  try {
    if (!skipBuild) {
      for (const [packageName] of sdkPackages) {
        await run(npmCommand, ["run", "build", `--workspace=${packageName}`], packageRoot);
      }
    }
    for (const [packageName, relativePath] of sdkPackages) {
      const sourceRoot = path.resolve(packageRoot, relativePath);
      const stagedRoot = path.join(stagingRoot, packageName.replaceAll("/", "-"));
      await mkdir(stagedRoot, { recursive: true });
      const packageJson = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
      if (packageJson.name !== packageName) throw new Error(`Expected ${packageName} at ${sourceRoot}`);
      const distRoot = path.join(sourceRoot, "dist");
      if (!(await exists(distRoot))) {
        throw new Error(`Paseo output not found at ${distRoot}; build Paseo first or omit --skip-build`);
      }
      await cp(distRoot, path.join(stagedRoot, "dist"), { recursive: true });
      const readmePath = path.join(sourceRoot, "README.md");
      if (await exists(readmePath)) await cp(readmePath, path.join(stagedRoot, "README.md"));
      packageJson.version = config.version;
      for (const location of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        for (const [sdkPackage] of sdkPackages) {
          if (packageJson[location]?.[sdkPackage] !== undefined) packageJson[location][sdkPackage] = config.version;
        }
      }
      await writeFile(path.join(stagedRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
      const before = new Set(await readdir(outputRoot));
      await run(npmCommand, ["pack", "--ignore-scripts", "--pack-destination", outputRoot], stagedRoot);
      const created = (await readdir(outputRoot)).filter((file) => !before.has(file) && file.endsWith(".tgz"));
      if (created.length !== 1) throw new Error(`Could not identify the ${packageName} package tarball`);
      tarballs.set(packageName, path.join(outputRoot, created[0]));
    }
    return { directory, tarballs };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function installLocalTarballs(plugin, tarballs) {
  const pluginRoot = path.join(root, plugin);
  await run(
    npmCommand,
    [
      "install",
      "--no-save",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--package-lock=false",
      ...tarballs.values(),
    ],
    pluginRoot,
  );
  await verifyInstalledSdk(plugin);
}

async function installOnline(plugins) {
  for (const plugin of plugins) {
    await run(npmCommand, ["install"], path.join(root, plugin));
    await verifyInstalledSdk(plugin);
  }
}

async function verifyInstalledSdk(plugin) {
  const pluginRoot = path.join(root, plugin);
  for (const [packageName] of sdkPackages) {
    const packageJsonPath = path.join(pluginRoot, "node_modules", ...packageName.split("/"), "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    if (packageJson.version !== config.version) {
      throw new Error(
        `${plugin} installed ${packageName}@${packageJson.version}; expected ${packageName}@${config.version}`,
      );
    }
  }
}

const options = parseArgs(process.argv.slice(2));
const plugins = selectedPlugins(options.plugins);
let temporaryDirectory;

try {
  let source = options.source;
  if (source === "auto") {
    if (await onlinePackagesAvailable()) source = "online";
    else if (options.tarballDir || (await exists(path.join(resolveHome(options.paseoRepo), "package.json")))) source = options.tarballDir ? "tarball" : "local";
    else throw new Error(`Paseo SDK ${config.version} is not available online and no local checkout or tarballs were found`);
  }

  if (source === "online") {
    await installOnline(plugins);
    console.log(`Installed Paseo SDK ${config.version} from the registry.`);
  } else {
    let tarballs;
    if (source === "local") {
      const packed = await packLocalPackages(options.paseoRepo, options.skipBuild);
      temporaryDirectory = packed.directory;
      tarballs = packed.tarballs;
    } else {
      if (!options.tarballDir) throw new Error("--tarball-dir is required when --source is tarball");
      const directory = path.resolve(resolveHome(options.tarballDir));
      if (!(await exists(directory))) throw new Error(`Tarball directory not found at ${directory}`);
      tarballs = await tarballsFromDirectory(directory);
    }
    for (const plugin of plugins) await installLocalTarballs(plugin, tarballs);
    console.log(`Installed Paseo SDK from ${source} tarballs for: ${plugins.join(", ")}.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error("Run with --source local or --source tarball when the SDK is not available online.");
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
