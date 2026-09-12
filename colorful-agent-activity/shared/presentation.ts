import { diffLines } from "diff";
import type { JsonValue, ToolCallDetail, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import { getPaseoToolLeafName } from "@getpaseo/protocol/tool-name-normalization";
import type { PaletteMode } from "./settings";
import { exaToolIcon, exaToolKind, exaToolLabel, exaToolSummary } from "./exa";
import {
  githubToolIcon,
  githubToolKind,
  githubToolLabel,
  githubToolSummary,
} from "./github";

export const TOOL_CATEGORIES = [
  "shell",
  "file",
  "search",
  "agent",
  "plan",
  "communication",
  "unknown",
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];
type ActivityCategory = ToolCategory | "reasoning";

export interface DiffStats {
  additions: number;
  deletions: number;
}

export interface DiffLine {
  kind: "add" | "remove" | "context" | "meta";
  text: string;
}

export interface ToolCallPresentation {
  category: ToolCategory;
  icon: string;
  label: string;
  summary?: string;
  filePath?: string;
  fileIcon?: string;
  language?: string;
  diffStats?: DiffStats;
}

export interface SubAgentActionPresentation {
  icon: string;
  label: string;
  summaryIcon?: string;
}

export interface SubAgentAction {
  index: number;
  toolName: string;
  summary?: string;
}

export interface ActivityThemeColors {
  surface0: string;
  surface1: string;
  surface2: string;
  border: string;
  foreground: string;
  foregroundMuted: string;
  accent: string;
  accentForeground: string;
  statusSuccess: string;
  statusWarning: string;
  statusDanger: string;
}

export interface ActivityPalette {
  mode: PaletteMode;
  categoryColors: Record<ActivityCategory, string>;
  categoryBackgrounds: Record<ActivityCategory, string>;
  statusColors: {
    running: string;
    completed: string;
    failed: string;
    canceled: string;
  };
  statusBackgrounds: {
    running: string;
    completed: string;
    failed: string;
    canceled: string;
  };
  borderWidth: number;
}

const EXTENSION_LANGUAGE: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  htm: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  less: "css",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  mts: "typescript",
  py: "python",
  pyw: "python",
  rs: "rust",
  sass: "css",
  scss: "css",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "typescript",
  vue: "html",
  wasm: "wasm",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

const FILE_ICON_BY_EXTENSION: Record<string, string> = {
  c: "FileCode2",
  cc: "FileCode2",
  cpp: "FileCode2",
  cs: "FileCode2",
  css: "FileType",
  go: "FileCode2",
  h: "FileCode2",
  hpp: "FileCode2",
  html: "FileCode2",
  java: "FileCode2",
  js: "FileCode2",
  json: "FileJson",
  jsonc: "FileJson",
  jsx: "FileCode2",
  less: "FileType",
  md: "FileText",
  mdx: "FileText",
  mjs: "FileCode2",
  mts: "FileCode2",
  py: "FileCode2",
  pyw: "FileCode2",
  rs: "FileCode2",
  sass: "FileType",
  scss: "FileType",
  sh: "FileTerminal",
  sql: "FileCode2",
  ts: "FileCode2",
  tsx: "FileCode2",
  vue: "FileCode2",
  wasm: "FileCog",
  xml: "FileCode2",
  yaml: "FileCog",
  yml: "FileCog",
  zsh: "FileTerminal",
};

const FILE_ICON_BY_NAME: Record<string, string> = {
  ".env": "FileKey2",
  ".gitignore": "FileCog",
  dockerfile: "FileCog",
  "package-lock.json": "FileJson",
  "package.json": "FileJson",
  "pnpm-lock.yaml": "FileCog",
  "yarn.lock": "FileKey2",
};

const TOOL_ICON_NAMES: Record<string, string> = {
  bot: "Bot",
  brain: "Brain",
  eye: "Eye",
  mic_vocal: "MicVocal",
  pencil: "Pencil",
  paseo: "Sparkles",
  search: "Search",
  sparkles: "Sparkles",
  square_terminal: "SquareTerminal",
  wrench: "Wrench",
};

function compactText(value: string, maxLength = 180): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1)?.toLowerCase() ?? filePath.toLowerCase();
}

export function extensionFromPath(filePath: string | undefined): string | null {
  if (!filePath) return null;
  const name = fileName(filePath);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1);
}

export function languageForFilePath(filePath: string | undefined): string | undefined {
  const extension = extensionFromPath(filePath);
  return extension ? EXTENSION_LANGUAGE[extension] : undefined;
}

export function fileIconForPath(filePath: string | undefined): string {
  if (!filePath) return "File";
  const name = fileName(filePath);
  const byName = FILE_ICON_BY_NAME[name];
  if (byName) return byName;
  const extension = extensionFromPath(filePath);
  return (extension && FILE_ICON_BY_EXTENSION[extension]) || "File";
}

function iconNameFromProtocol(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return TOOL_ICON_NAMES[value] ?? value;
}

function prettyToolName(name: string): string {
  const normalized = name.trim().replace(/[._-]+/g, " ");
  if (!normalized) return "Tool";
  return normalized
    .split(/\s+/)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

const PASEO_TOOL_LABELS: Readonly<Record<string, string>> = {
  speak: "Speak",
  create_workspace: "Create Workspace",
  list_workspaces: "List Workspaces",
  archive_workspace: "Archive Workspace",
  create_agent: "Create Agent",
  send_agent_prompt: "Send Agent Prompt",
  get_agent_status: "Get Agent Status",
  list_agents: "List Agents",
  cancel_agent: "Cancel Agent Run",
  archive_agent: "Archive Agent",
  kill_agent: "Kill Agent",
  update_agent: "Update Agent",
  rename_workspace: "Rename Workspace",
  list_workspace_scripts: "List Workspace Scripts",
  start_workspace_script: "Start Workspace Script",
  stop_workspace_script: "Stop Workspace Script",
  list_terminals: "List Terminals",
  create_terminal: "Create Terminal",
  kill_terminal: "Kill Terminal",
  capture_terminal: "Capture Terminal",
  send_terminal_keys: "Send Terminal Keys",
  create_schedule: "Create Schedule",
  create_heartbeat: "Create Heartbeat",
  delete_heartbeat: "Delete Heartbeat",
  list_schedules: "List Schedules",
  inspect_schedule: "Inspect Schedule",
  pause_schedule: "Pause Schedule",
  resume_schedule: "Resume Schedule",
  delete_schedule: "Delete Schedule",
  update_schedule: "Update Schedule",
  schedule_logs: "Schedule Logs",
  run_schedule_once: "Run Schedule Once",
  list_providers: "List Providers",
  list_models: "List Models",
  list_profiles: "List Agent Profiles",
  inspect_provider: "Inspect Provider",
  get_agent_activity: "Get Agent Activity",
  set_agent_mode: "Set Agent Session Mode",
  list_pending_permissions: "List Pending Permissions",
  respond_to_permission: "Respond to Permission",
  browser_list_tabs: "List Browser Tabs",
  browser_new_tab: "Create Browser Tab",
  browser_snapshot: "Snapshot Browser Page",
  browser_click: "Click Browser Element",
  browser_fill: "Fill Browser Element",
  browser_wait: "Wait for Browser Condition",
  browser_type: "Type into Browser",
  browser_keypress: "Press Browser Key",
  browser_navigate: "Navigate Browser",
  browser_back: "Browser Back",
  browser_forward: "Browser Forward",
  browser_reload: "Browser Reload",
  browser_screenshot: "Capture Browser Screenshot",
  browser_upload: "Upload Files in Browser",
  browser_hover: "Hover Browser Element",
  browser_select: "Select Browser Option",
  browser_drag: "Drag Browser Element",
  browser_logs: "Read Browser Logs",
  browser_evaluate: "Evaluate Browser JavaScript",
  browser_scroll: "Scroll Browser",
  browser_resize: "Resize Browser Viewport",
  browser_close_tab: "Close Browser Tab",
};

const PASEO_TOOL_ICONS: Readonly<Record<string, string>> = {
  speak: "MicVocal",
  create_workspace: "FolderPlus",
  list_workspaces: "Folders",
  archive_workspace: "Archive",
  create_agent: "Bot",
  send_agent_prompt: "Send",
  get_agent_status: "Activity",
  list_agents: "Users",
  cancel_agent: "CircleStop",
  archive_agent: "Archive",
  kill_agent: "CircleX",
  update_agent: "Settings2",
  rename_workspace: "Pencil",
  list_workspace_scripts: "ListTree",
  start_workspace_script: "Play",
  stop_workspace_script: "Square",
  list_terminals: "SquareTerminal",
  create_terminal: "SquareTerminal",
  kill_terminal: "CircleX",
  capture_terminal: "ScrollText",
  send_terminal_keys: "Keyboard",
  create_schedule: "CalendarClock",
  create_heartbeat: "HeartPulse",
  delete_heartbeat: "Trash2",
  list_schedules: "CalendarDays",
  inspect_schedule: "CalendarSearch",
  pause_schedule: "Pause",
  resume_schedule: "Play",
  delete_schedule: "Trash2",
  update_schedule: "CalendarCog",
  schedule_logs: "ScrollText",
  run_schedule_once: "CalendarCheck",
  list_providers: "Network",
  list_models: "Cpu",
  list_profiles: "ContactRound",
  inspect_provider: "ScanSearch",
  get_agent_activity: "ListActivity",
  set_agent_mode: "SlidersHorizontal",
  list_pending_permissions: "ShieldAlert",
  respond_to_permission: "ShieldCheck",
  browser_list_tabs: "PanelsTopLeft",
  browser_new_tab: "Globe2",
  browser_snapshot: "Scan",
  browser_click: "MousePointer2",
  browser_fill: "TextCursorInput",
  browser_wait: "Timer",
  browser_type: "Keyboard",
  browser_keypress: "KeyRound",
  browser_navigate: "Navigation",
  browser_back: "ArrowLeft",
  browser_forward: "ArrowRight",
  browser_reload: "RefreshCw",
  browser_screenshot: "Camera",
  browser_upload: "Upload",
  browser_hover: "Hand",
  browser_select: "ListFilter",
  browser_drag: "Move",
  browser_logs: "ScrollText",
  browser_evaluate: "Braces",
  browser_scroll: "Scroll",
  browser_resize: "Maximize2",
  browser_close_tab: "X",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

export function paseoToolLeafName(toolName: string): string | null {
  const namespacedLeafName = getPaseoToolLeafName(toolName);
  if (namespacedLeafName && PASEO_TOOL_LABELS[namespacedLeafName]) {
    return namespacedLeafName;
  }
  const normalized = toolName.trim().toLowerCase();
  const directMatch = normalized.match(/^(?:mcp_)?paseo_(.+)$/);
  const directLeafName = directMatch?.[1];
  return directLeafName && PASEO_TOOL_LABELS[directLeafName] ? directLeafName : null;
}

export function paseoToolLabel(toolName: string): string | null {
  const leafName = paseoToolLeafName(toolName);
  if (!leafName) return null;
  return PASEO_TOOL_LABELS[leafName] ?? prettyToolName(leafName);
}

export function paseoToolIcon(toolName: string): string | null {
  const leafName = paseoToolLeafName(toolName);
  if (!leafName) return null;
  return PASEO_TOOL_ICONS[leafName] ?? "Sparkles";
}

export function paseoToolCategory(toolName: string): ToolCategory | null {
  const leafName = paseoToolLeafName(toolName);
  if (!leafName) return null;
  if (leafName.startsWith("browser_")) return "search";
  if (leafName.includes("terminal") || leafName.includes("workspace_script")) return "shell";
  if (leafName.includes("schedule") || leafName.includes("heartbeat")) return "plan";
  if (leafName.includes("provider") || leafName.includes("profile")) return "agent";
  if (leafName.includes("agent") || leafName.includes("permission")) return "agent";
  if (leafName === "speak") return "communication";
  if (leafName.includes("workspace")) return "file";
  return "unknown";
}

export function paseoToolSummary(toolName: string, input: unknown): string | undefined {
  const leafName = paseoToolLeafName(toolName);
  if (!leafName) return undefined;
  const title = stringField(input, "title");
  const provider = stringField(input, "provider");
  const agentId = stringField(input, "agentId");
  const workspaceId = stringField(input, "workspaceId");
  const browserId = stringField(input, "browserId");
  const url = stringField(input, "url");
  const prompt = stringField(input, "prompt") ?? stringField(input, "initialPrompt");
  if (leafName === "create_agent" && title && provider) return `${title} · ${provider}`;
  if (leafName === "create_agent" && title) return title;
  if (leafName === "send_agent_prompt" && agentId) return agentId;
  if (leafName.endsWith("_agent") && agentId) return agentId;
  if (leafName.includes("workspace") && workspaceId) return workspaceId;
  if (leafName.startsWith("browser_") && url) return url;
  if (leafName.startsWith("browser_") && browserId) return browserId;
  if ((leafName === "create_schedule" || leafName === "create_heartbeat") && prompt) {
    return compactText(prompt);
  }
  if (leafName === "list_models" && provider) return provider;
  if (leafName === "speak" && stringField(input, "text")) return compactText(stringField(input, "text")!);
  return undefined;
}

function parseEmbeddedJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    for (const match of value.matchAll(/\{|\[/g)) {
      const offset = match.index;
      if (offset === undefined) continue;
      try {
        return JSON.parse(value.slice(offset)) as unknown;
      } catch {
        continue;
      }
    }
    return undefined;
  }
}

export function unwrapPaseoToolOutput(value: unknown): unknown {
  const record = isRecord(value) ? value : null;
  if (!record) return value;
  if (record.structuredContent !== undefined) return unwrapPaseoToolOutput(record.structuredContent);
  if (Array.isArray(record.content)) {
    const content = record.content.find((item) => isRecord(item) && item.type === "text");
    if (isRecord(content)) {
      const parsed = typeof content.text === "string" ? parseEmbeddedJson(content.text) : undefined;
      return parsed === undefined ? content.text : unwrapPaseoToolOutput(parsed);
    }
  }
  return value;
}

export function paseoToolResult(value: unknown): unknown {
  const unwrapped = unwrapPaseoToolOutput(value);
  const record = isRecord(unwrapped) ? unwrapped : null;
  return record?.ok === true && record.result !== undefined ? record.result : unwrapped;
}

function countLines(value: string): number {
  if (!value) return 0;
  const lines = value.replace(/\r/g, "").split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function diffStatsFromUnifiedDiff(unifiedDiff: string): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const line of unifiedDiff.replace(/\r/g, "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export function diffStatsFromStrings(oldString: string, newString: string): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const change of diffLines(oldString, newString)) {
    if (change.added) additions += countLines(change.value);
    if (change.removed) deletions += countLines(change.value);
  }
  return { additions, deletions };
}

export function diffStatsForDetail(detail: Extract<ToolCallDetail, { type: "edit" }>): DiffStats {
  if (detail.unifiedDiff !== undefined) return diffStatsFromUnifiedDiff(detail.unifiedDiff);
  return diffStatsFromStrings(detail.oldString ?? "", detail.newString ?? "");
}

function linesForChange(value: string): string[] {
  const normalized = value.replace(/\r/g, "");
  if (!normalized) return [];
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function diffLinesForDetail(detail: Extract<ToolCallDetail, { type: "edit" }>): DiffLine[] {
  if (detail.unifiedDiff !== undefined) {
    return detail.unifiedDiff
      .replace(/\r/g, "")
      .split("\n")
      .filter((line, index, lines) => !(index === lines.length - 1 && line === ""))
      .map((line) => {
        if (line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")) {
          return { kind: "meta", text: line };
        }
        if (line.startsWith("+")) return { kind: "add", text: line.slice(1) };
        if (line.startsWith("-")) return { kind: "remove", text: line.slice(1) };
        if (line.startsWith(" ")) return { kind: "context", text: line.slice(1) };
        return { kind: "context", text: line };
      });
  }

  return diffLines(detail.oldString ?? "", detail.newString ?? "").flatMap((change) => {
    const kind = change.added ? "add" : change.removed ? "remove" : "context";
    return linesForChange(change.value).map((text) => ({ kind, text }));
  });
}

function shellSummary(detail: Extract<ToolCallDetail, { type: "shell" }>): string | undefined {
  return compactText(detail.command);
}

function detailFilePath(detail: ToolCallDetail): string | undefined {
  if (detail.type === "read" || detail.type === "edit" || detail.type === "write") {
    return detail.filePath || undefined;
  }
  return undefined;
}

export function resolveToolCallPresentation(
  item: Pick<ToolCallTimelineItem, "name" | "detail">,
): ToolCallPresentation {
  const name = item.name.trim().toLowerCase();
  const detail = item.detail;
  const filePath = detailFilePath(detail);
  const commonFileFields = filePath
    ? {
        filePath,
        fileIcon: fileIconForPath(filePath),
        language: languageForFilePath(filePath),
      }
    : {};

  switch (detail.type) {
    case "shell":
      return {
        category: "shell",
        icon: "SquareTerminal",
        label: "Shell Command",
        summary: shellSummary(detail),
      };
    case "worktree_setup":
      return {
        category: "shell",
        icon: "GitBranch",
        label: "Worktree Setup",
        summary: compactText(detail.branchName || detail.worktreePath),
      };
    case "read":
      return {
        category: "file",
        icon: commonFileFields.fileIcon ?? "Eye",
        label: "Read File",
        summary: compactText(detail.filePath),
        ...commonFileFields,
      };
    case "edit":
      return {
        category: "file",
        icon: commonFileFields.fileIcon ?? "Pencil",
        label: "Edit File",
        summary: compactText(detail.filePath),
        diffStats: diffStatsForDetail(detail),
        ...commonFileFields,
      };
    case "write":
      return {
        category: "file",
        icon: commonFileFields.fileIcon ?? "Pencil",
        label: "Write File",
        summary: compactText(detail.filePath),
        ...commonFileFields,
      };
    case "search":
      return {
        category: "search",
        icon: "Search",
        label: "Search",
        summary: compactText(detail.query),
      };
    case "fetch":
      return {
        category: "search",
        icon: "Globe",
        label: "Fetch URL",
        summary: compactText(detail.url),
      };
    case "sub_agent":
      return {
        category: "agent",
        icon: "Bot",
        label: "Agent Task",
        summary: detail.description
          ? compactText(detail.description)
          : compactText(detail.subAgentType ?? ""),
      };
    case "plain_text":
      return {
        category: "communication",
        icon: iconNameFromProtocol(detail.icon) ?? "Wrench",
        label: detail.label || prettyToolName(item.name),
        summary: detail.text ? compactText(detail.text) : undefined,
      };
    case "plan":
      return {
        category: "plan",
        icon: "ListChecks",
        label: "Plan",
      };
    case "unknown": {
      if (name === "thinking") {
        return { category: "plan", icon: "Brain", label: "Thinking" };
      }
      if (name === "task") {
        return { category: "agent", icon: "Bot", label: "Task", summary: compactText(item.name) };
      }
      if (name === "speak") {
        return { category: "communication", icon: "MicVocal", label: "Speak" };
      }
      const githubKind = githubToolKind(item.name);
      if (githubKind) {
        return {
          category: githubKind === "pull-request" || githubKind === "actions-run" ? "agent" : "search",
          icon: githubToolIcon(githubKind),
          label: githubToolLabel(githubKind),
          summary: githubToolSummary(githubKind, detail.input),
        };
      }
      const exaKind = exaToolKind(item.name);
      if (exaKind) {
        return {
          category: exaKind === "agent" ? "agent" : "search",
          icon: exaToolIcon(exaKind),
          label: exaToolLabel(exaKind),
          summary: exaToolSummary(exaKind, detail.input),
        };
      }
      const paseoLabel = paseoToolLabel(item.name);
      if (paseoLabel) {
        return {
          category: paseoToolCategory(item.name) ?? "unknown",
          icon: paseoToolIcon(item.name) ?? "Sparkles",
          label: `Paseo ${paseoLabel}`,
          summary: paseoToolSummary(item.name, detail.input),
        };
      }
      return {
        category: "unknown",
        icon: "Wrench",
        label: prettyToolName(item.name),
      };
    }
  }
}

export function resolveSubAgentActionPresentation(
  toolName: string,
  summary?: string,
): SubAgentActionPresentation {
  const normalized = toolName.trim().toLowerCase().replace(/[\s.-]+/g, "_");
  if (normalized === "read" || normalized.includes("read_file") || normalized.includes("readfile")) {
    return { icon: "FileText", label: "Read File", summaryIcon: fileIconForPath(summary) };
  }
  if (
    normalized === "glob" ||
    normalized === "find" ||
    normalized.includes("find_file") ||
    normalized.includes("list_file")
  ) {
    return { icon: "Search", label: "Find Files" };
  }
  if (normalized === "grep" || normalized === "search" || normalized.includes("search")) {
    return { icon: "Search", label: "Search" };
  }
  if (
    normalized === "bash" ||
    normalized === "sh" ||
    normalized === "run" ||
    normalized.includes("shell") ||
    normalized.includes("command")
  ) {
    return { icon: "SquareTerminal", label: "Shell Command" };
  }
  if (normalized === "edit" || normalized.includes("edit_file") || normalized.includes("patch")) {
    return { icon: "Pencil", label: "Edit File", summaryIcon: fileIconForPath(summary) };
  }
  if (normalized === "write" || normalized.includes("write_file") || normalized.includes("writefile")) {
    return { icon: "Pencil", label: "Write File", summaryIcon: fileIconForPath(summary) };
  }
  if (normalized === "task" || normalized.includes("sub_agent") || normalized.includes("subagent")) {
    return { icon: "Bot", label: "Agent Task" };
  }
  return { icon: "Wrench", label: toolName.trim() || "Tool" };
}

export function parseSubAgentActionLog(log: string): readonly SubAgentAction[] {
  const actions: SubAgentAction[] = [];
  for (const line of log.split(/\r?\n/)) {
    const match = line.trim().match(/^\[([^\]]+)\]\s*(.*)$/);
    if (!match?.[1]) continue;
    const toolName = match[1].trim();
    if (!toolName) continue;
    const summary = match[2]?.trim();
    actions.push({
      index: actions.length,
      toolName,
      ...(summary ? { summary } : {}),
    });
  }
  return actions;
}

function parseHexColor(value: string): [number, number, number] | null {
  const match = value.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (!match) return null;
  const hex = match[1];
  if (!hex) return null;
  if (hex.length === 3) {
    return [
      Number.parseInt(`${hex[0]}${hex[0]}`, 16),
      Number.parseInt(`${hex[1]}${hex[1]}`, 16),
      Number.parseInt(`${hex[2]}${hex[2]}`, 16),
    ];
  }
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function tintColor(color: string, alpha: number, fallback: string): string {
  const rgb = parseHexColor(color);
  return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})` : fallback;
}

export function resolveActivityPalette(
  mode: PaletteMode,
  colors: ActivityThemeColors,
): ActivityPalette {
  const alpha = mode === "vivid" ? 0.1 : mode === "high_contrast" ? 0.16 : 0.06;
  const categoryColors: Record<ActivityCategory, string> = {
    reasoning: mode === "vivid" ? colors.accent : colors.foregroundMuted,
    shell: colors.statusWarning,
    file: mode === "vivid" ? colors.accent : colors.foregroundMuted,
    search: mode === "vivid" ? colors.accent : colors.foregroundMuted,
    agent: mode === "vivid" ? colors.statusSuccess : colors.foregroundMuted,
    plan: colors.foregroundMuted,
    communication: mode === "vivid" ? colors.accent : colors.foregroundMuted,
    unknown: colors.foregroundMuted,
  };
  const statusColors = {
    running: colors.accent,
    completed: colors.statusSuccess,
    failed: colors.statusDanger,
    canceled: colors.foregroundMuted,
  };
  const categoryBackgrounds = Object.fromEntries(
    Object.entries(categoryColors).map(([category, color]) => [
      category,
      tintColor(color, alpha, colors.surface2),
    ]),
  ) as Record<ActivityCategory, string>;
  const statusBackgrounds = Object.fromEntries(
    Object.entries(statusColors).map(([status, color]) => [
      status,
      tintColor(color, alpha, colors.surface2),
    ]),
  ) as ActivityPalette["statusBackgrounds"];
  return {
    mode,
    categoryColors,
    categoryBackgrounds,
    statusColors,
    statusBackgrounds,
    borderWidth: mode === "high_contrast" ? 2 : 1,
  };
}

export function toJsonValue(value: unknown): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : (JSON.parse(serialized) as JsonValue);
  } catch {
    return null;
  }
}

export function formatUnknownValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatError(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  const text = typeof error === "string" ? error : formatUnknownValue(error);
  return compactText(text, 400);
}

export function formatReasoningText(text: string): string {
  if (!text) return "";
  const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(/(\*\*[^*\s\n](?:[^*\n]*?[^*\s\n])?\*\*)\s*(?=\*\*)/g, "$1\n\n");
    })
    .join("");
}
