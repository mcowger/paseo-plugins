import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const sourceHome = os.homedir();
const root = path.resolve(process.env.SUPERPI_TEST_DIR ?? path.join(import.meta.dirname, "../.test-env/simple"));
const port = Number(process.env.SUPERPI_TEST_PORT ?? 6899);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 6767) throw new Error("Choose a separate test port");
if (root === sourceHome || root === "/" || root.startsWith(`${sourceHome}/.pi/`)) throw new Error("Unsafe test directory");
process.umask(0o077);

const env = {
  PATH: `${root}/node_modules/.bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
  HOME: `${root}/home`, LANG: "C.UTF-8", TMPDIR: `${root}/tmp`,
  XDG_CONFIG_HOME: `${root}/home/.config`, XDG_CACHE_HOME: `${root}/home/.cache`,
  XDG_DATA_HOME: `${root}/home/.local/share`, GIT_CEILING_DIRECTORIES: root,
  PASEO_HOME: `${root}/paseo`, PASEO_LISTEN: `127.0.0.1:${port}`,
  PASEO_WEB_UI_ENABLED: "true", PASEO_RELAY_ENABLED: "false",
  PI_PACKAGE_DIR: `${root}/pi`, PI_CODING_AGENT_DIR: `${root}/pi-agent`,
  PI_CODING_AGENT_SESSION_DIR: `${root}/sessions`, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
  SUPERPI_PI_COMMAND: `${root}/pi/pi`,
  SUPERPI_COMPANION_PATH: `${root}/extensions/superpi-companion/index.ts`,
};
const json = async (file, data) => fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
const exists = (file) => fs.access(file).then(() => true, () => false);
const extensionSources = [
  `${sourceHome}/workspace/pi-stuff/pi-plugins/packages/pi-subagents`,
  `${sourceHome}/workspace/pi-stuff/pi-plugins/packages/pi-control`,
  `${sourceHome}/workspace/pi-stuff/plexus-agent-plugins/packages/plexus-pi`,
];
const copyResource = (source, destination) => fs.cp(source, destination, {
  recursive: true, dereference: true, filter: async (file) => {
    const paths = [file, await fs.realpath(file)];
    return paths.every((p) => !p.split(path.sep).some((part) =>
      ["node_modules", ".git", "secrets", "auth.json"].includes(part) || part.startsWith(".env") || part.endsWith(".log")));
  },
});
const run = (command, args, cwd = root) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env, cwd, stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code, signal) => code === 0 || signal === "SIGINT" ? resolve() : reject(new Error(`${command} exited ${code ?? signal}`)));
});

async function setup() {
  for (const dir of ["home", "tmp", "paseo", "pi-agent/extensions/plexus", "pi-agent/agents", "sessions", "workspace", "extensions"]) {
    await fs.mkdir(`${root}/${dir}`, { recursive: true });
  }
  await fs.cp(process.env.SUPERPI_PI_DIST ?? `${sourceHome}/.local/share/path-overrides/pi-local`, `${root}/pi`, { recursive: true, dereference: true });
  const packages = [];
  const dependencies = { "@getpaseo/cli": "0.11.0-beta.3" };
  for (const source of extensionSources) {
    const destination = `${root}/extensions/${path.basename(source)}`;
    await copyResource(source, destination);
    const metadata = JSON.parse(await fs.readFile(`${destination}/package.json`, "utf8"));
    Object.assign(dependencies, metadata.dependencies ?? {});
    packages.push(destination);
  }
  await json(`${root}/package.json`, { private: true, dependencies });
  await run("npm", ["install", "--no-audit", "--no-fund"]);
  await json(`${root}/pi-agent/settings.json`, {
    packages, defaultProvider: "superpi-test", defaultModel: "deepseek-v4.1-flash", defaultThinkingLevel: "off",
    retry: { enabled: false },
  });
  await json(`${root}/pi-agent/trust.json`, { [`${root}/workspace`]: true });
  await json(`${root}/pi-agent/pi-subagents.json`, { maxDepth: 1 });
  await fs.writeFile(`${root}/pi-agent/agents/lab-worker.md`, "---\nname: lab-worker\ndescription: Isolated test worker\nmodel: superpi-test/deepseek-v4.1-flash\nthinking: off\nmax_turns: 3\n---\nUse the test workspace only.\n");
  await json(`${root}/pi-agent/extensions/plexus/config.json`, {
    baseUrl: process.env.PLEXUS_STAGING_URL ?? "https://plexus.home.cowger.us",
    apiKeyEnv: "SUPERPI_STAGING_API_KEY",
  });
  await json(`${root}/pi-agent/models.json`, { providers: { "superpi-test": {
    baseUrl: `${(process.env.PLEXUS_STAGING_URL ?? "https://plexus.home.cowger.us").replace(/\/$/, "")}/v1`,
    api: "openai-completions", apiKey: "$SUPERPI_STAGING_API_KEY",
    models: [{ id: "deepseek-v4.1-flash", name: "DeepSeek test model", reasoning: false,
      input: ["text"], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } });
  await json(`${root}/paseo/config.json`, {
    version: 1, pluginsEnabled: true, daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false },
      mcp: { enabled: true, injectIntoAgents: false } },
    features: { webUi: { enabled: true }, dictation: { enabled: false }, voiceMode: { enabled: false } },
    agents: { providers: { pi: { enabled: true, env: {
      HOME: env.HOME, PI_PACKAGE_DIR: env.PI_PACKAGE_DIR,
      PI_CODING_AGENT_DIR: env.PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR: env.PI_CODING_AGENT_SESSION_DIR,
    }, command: { mode: "replace", argv: [`${root}/pi/pi`] } },
      claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false }, omp: { enabled: false } } },
  });
  await fs.writeFile(`${root}/workspace/fixture.txt`, "Isolated testing workspace.\n");
  console.log(`Prepared ${root}`);
}

if (!(await exists(`${root}/paseo/config.json`))) await setup();
if (process.argv.includes("--sync-companion") || process.argv.includes("--sync-resources")) {
  const source = path.resolve(import.meta.dirname, "../../superpi-companion");
  await copyResource(source, `${root}/extensions/superpi-companion`);
  if (process.argv.includes("--sync-resources")) {
    for (const extension of extensionSources) await copyResource(extension, `${root}/extensions/${path.basename(extension)}`);
  }
  console.log("Copied test resources without changing the isolated configuration.");
  process.exit(0);
}
if (process.argv.includes("--setup")) process.exit(0);

env.SUPERPI_STAGING_API_KEY = process.env.SUPERPI_STAGING_API_KEY;
if (!env.SUPERPI_STAGING_API_KEY) {
  const keyFile = process.env.SUPERPI_TEST_KEY_FILE ?? path.join(import.meta.dirname, "../.test-env/live/staging-credential.json");
  if ((await fs.stat(keyFile)).mode & 0o077) throw new Error("Test key file must have private permissions");
  env.SUPERPI_STAGING_API_KEY = JSON.parse(await fs.readFile(keyFile, "utf8")).secret;
}
if (!env.SUPERPI_STAGING_API_KEY) throw new Error("Supply a dedicated SUPERPI_STAGING_API_KEY or SUPERPI_TEST_KEY_FILE");
const cli = `${root}/node_modules/.bin/paseo`;
const args = process.argv.slice(2);
if (args[0] === "--cli") {
  const command = args.slice(1);
  if (command.some((arg) => /^--(home|host)(=|$)/.test(arg))) throw new Error("The script owns the daemon target");
  await run(cli, [...command.slice(0, 2), "--help"]);
  await run(cli, [...command, "--home", env.PASEO_HOME]);
} else {
  await run(cli, ["daemon", "run", "--help"]);
  console.log(`Web: http://127.0.0.1:${port}/\nWorkspace: ${root}/workspace\nCtrl-C stops this foreground test daemon.`);
  await run(cli, ["daemon", "run", "--home", env.PASEO_HOME], `${root}/workspace`);
}
