/**
 * 本地补丁：语言和工具的小色标（TS、PY、git、npm……），借鉴 beautiful-chat 的品牌图标，但不带任何图片：
 * 原生端的 <Image> 不画 SVG，beautiful-chat 为此打包了 PNG 位图；这里只用一块品牌色加两三个字母，手机上零成本。
 * 色值取各项目公开的品牌主色。
 */
export interface Badge {
  label: string;
  /** Brand colour of the chip. */
  color: string;
  /** Text on the chip: light (white) or dark (near black), whichever reads on that colour. */
  ink: "light" | "dark";
}

const badge = (label: string, color: string, ink: Badge["ink"] = "light"): Badge => ({ label, color, ink });

const BY_EXTENSION: Readonly<Record<string, Badge>> = {
  ts: badge("TS", "#3178C6"), tsx: badge("TSX", "#3178C6"), mts: badge("TS", "#3178C6"), cts: badge("TS", "#3178C6"),
  js: badge("JS", "#F7DF1E", "dark"), jsx: badge("JSX", "#F7DF1E", "dark"), mjs: badge("JS", "#F7DF1E", "dark"), cjs: badge("JS", "#F7DF1E", "dark"),
  py: badge("PY", "#3776AB"), pyi: badge("PY", "#3776AB"), ipynb: badge("IPYNB", "#F37626"),
  go: badge("GO", "#00ADD8"), rs: badge("RS", "#CE422B"), rb: badge("RB", "#CC342D"), java: badge("JAVA", "#E76F00"),
  kt: badge("KT", "#7F52FF"), kts: badge("KT", "#7F52FF"), swift: badge("SWIFT", "#F05138"), dart: badge("DART", "#0175C2"),
  c: badge("C", "#5C6BC0"), h: badge("H", "#5C6BC0"), cc: badge("C++", "#00599C"), cpp: badge("C++", "#00599C"), hpp: badge("C++", "#00599C"),
  cs: badge("C#", "#239120"), php: badge("PHP", "#777BB4"), lua: badge("LUA", "#2C2D72"), ex: badge("EX", "#4B275F"), exs: badge("EX", "#4B275F"),
  sh: badge("SH", "#4EAA25"), bash: badge("SH", "#4EAA25"), zsh: badge("SH", "#4EAA25"), fish: badge("SH", "#4EAA25"), ps1: badge("PS", "#5391FE"),
  json: badge("JSON", "#CB8A00", "dark"), jsonc: badge("JSON", "#CB8A00", "dark"), jsonl: badge("JSONL", "#CB8A00", "dark"),
  yaml: badge("YAML", "#CB171E"), yml: badge("YAML", "#CB171E"), toml: badge("TOML", "#9C4121"), xml: badge("XML", "#0060AC"),
  md: badge("MD", "#5B6B7F"), mdx: badge("MDX", "#5B6B7F"), txt: badge("TXT", "#6B7280"), csv: badge("CSV", "#217346"),
  html: badge("HTML", "#E34F26"), css: badge("CSS", "#1572B6"), scss: badge("SCSS", "#CC6699"), vue: badge("VUE", "#42B883"),
  svelte: badge("SVELTE", "#FF3E00"), sql: badge("SQL", "#336791"), graphql: badge("GQL", "#E10098"), proto: badge("PROTO", "#4285F4"),
  png: badge("PNG", "#8E44AD"), jpg: badge("JPG", "#8E44AD"), jpeg: badge("JPG", "#8E44AD"), gif: badge("GIF", "#8E44AD"), webp: badge("WEBP", "#8E44AD"),
  svg: badge("SVG", "#FFB13B", "dark"), lock: badge("LOCK", "#6B7280"), env: badge("ENV", "#ECD53F", "dark"),
};

const BY_NAME: Readonly<Record<string, Badge>> = {
  dockerfile: badge("DOCKER", "#2496ED"), makefile: badge("MAKE", "#6D8086"), "package.json": badge("NPM", "#CB3837"),
  "cargo.toml": badge("CARGO", "#CE422B"), "go.mod": badge("GO", "#00ADD8"), ".gitignore": badge("GIT", "#F05032"),
};

/** The chip for a file path: by well-known name first, then by extension. */
export function fileBadge(path: string | undefined | null): Badge | null {
  if (!path) return null;
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (BY_NAME[name]) return BY_NAME[name]!;
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

const BY_COMMAND: Readonly<Record<string, Badge>> = {
  git: badge("git", "#F05032"), gh: badge("gh", "#24292F"),
  npm: badge("npm", "#CB3837"), npx: badge("npx", "#CB3837"), pnpm: badge("pnpm", "#F69220", "dark"), yarn: badge("yarn", "#2C8EBB"),
  bun: badge("bun", "#FBF0DF", "dark"), bunx: badge("bun", "#FBF0DF", "dark"), node: badge("node", "#5FA04E"), deno: badge("deno", "#70FFAF", "dark"),
  tsc: badge("tsc", "#3178C6"), vitest: badge("vitest", "#6E9F18"), jest: badge("jest", "#C21325"), eslint: badge("eslint", "#4B32C3"),
  oxlint: badge("oxlint", "#3CB4E7", "dark"), prettier: badge("prettier", "#F7B93E", "dark"), playwright: badge("pw", "#2EAD33"),
  python: badge("py", "#3776AB"), python3: badge("py", "#3776AB"), pip: badge("pip", "#3776AB"), pip3: badge("pip", "#3776AB"),
  uv: badge("uv", "#DE5FE9"), pytest: badge("pytest", "#0A9EDC"),
  cargo: badge("cargo", "#CE422B"), rustc: badge("rustc", "#CE422B"), go: badge("go", "#00ADD8"),
  docker: badge("docker", "#2496ED"), kubectl: badge("k8s", "#326CE5"), helm: badge("helm", "#0F1689"), terraform: badge("tf", "#7B42BC"),
  make: badge("make", "#6D8086"), curl: badge("curl", "#0B5394"), wget: badge("wget", "#0B5394"), ssh: badge("ssh", "#4D4D4D"),
  psql: badge("psql", "#336791"), sqlite3: badge("sqlite", "#0F80CC"), redis: badge("redis", "#DC382D"),
  paseo: badge("paseo", "#0EA5E9"), claude: badge("claude", "#D97757"), codex: badge("codex", "#10A37F"),
};

const PREFIX_WORDS = new Set(["sudo", "env", "time", "nohup", "exec", "command", "timeout", "nice", "xargs"]);

/**
 * The chip for a shell command: the first real program, after `cd … &&`, environment assignments and wrappers
 * (`sudo`, `env`, `timeout 30` …). Plain utilities (ls, cat, grep, sed) get no chip.
 */
export function commandBadge(command: string | undefined | null): Badge | null {
  if (!command) return null;
  for (const part of command.split(/&&|\|\||;|\|/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    let index = 0;
    while (index < words.length) {
      const word = words[index]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || PREFIX_WORDS.has(word) || word.startsWith("-") || /^\d+[smhd]?$/.test(word)) {
        index += 1;
        continue;
      }
      break;
    }
    const program = words[index];
    if (!program || program === "cd" || program === "pushd") continue;
    const name = program.split("/").pop()!.toLowerCase();
    return BY_COMMAND[name] ?? null;
  }
  return null;
}

/** Ink colour for a chip. */
export function badgeInk(item: Badge): string {
  return item.ink === "dark" ? "#111317" : "#FFFFFF";
}
