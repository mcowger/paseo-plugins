import type { JsonValue, ToolCallDetail, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import { getPaseoToolLeafName } from "@getpaseo/protocol/tool-name-normalization";
import type { ExpansionTarget, PaletteMode } from "./settings";
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

export function compactText(value: string, maxLength = 180): string | undefined {
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

/**
 * Strip a workspace root prefix for compact header display. Returns the path
 * unchanged when it is already relative, outside the root, or no root applies.
 */
export function relativeToRoot(filePath: string, root: string | undefined): string {
  if (!filePath || !root) return filePath;
  const normalizedRoot = root.replace(/\/+$/, "");
  if (!normalizedRoot) return filePath;
  if (normalizedRoot === "/") return filePath.startsWith("/") ? filePath.slice(1) || filePath : filePath;
  if (filePath === normalizedRoot) return filePath.split("/").pop() ?? filePath;
  if (filePath.startsWith(`${normalizedRoot}/`)) return filePath.slice(normalizedRoot.length + 1);
  return filePath;
}

export interface FileDisplay {
  dir?: string;
  base: string;
}

/** Split a display path into a muted directory and a bold filename. */
export function splitFileDisplay(path: string): FileDisplay {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return { base: path };
  const dir = path.slice(0, slash);
  const base = path.slice(slash + 1) || path;
  return dir ? { dir, base } : { base };
}

/**
 * Front-truncate a directory to its last segments so long paths keep their
 * tail (`…/last/two`). Absolute dirs keep their leading slash when intact.
 */
export function truncateDirFront(dir: string, maxSegments = 2): string {
  const absolute = dir.startsWith("/");
  const segments = dir.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= maxSegments) return `${absolute ? "/" : ""}${segments.join("/")}`;
  return `…/${segments.slice(-maxSegments).join("/")}`;
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

export const PASEO_TOOL_ICONS: Readonly<Record<string, string>> = {
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
  get_agent_activity: "Activity",
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

/**
 * Which expansion setting governs a tool call row. Most tools key off their
 * body renderer (detail type); ask and speak share the unknown renderer, so
 * they key off the tool name instead — same table, no special handling.
 */
export function expansionTargetForToolCall(toolName: string, detailType: string): ExpansionTarget {
  if (isAskTool(toolName)) return "ask";
  if (toolName.trim().toLowerCase() === "speak") return "speak";
  switch (detailType) {
    case "read":
    case "edit":
    case "write":
    case "shell":
    case "search":
    case "fetch":
    case "worktree_setup":
    case "sub_agent":
    case "plain_text":
    case "plan":
      return detailType;
    default:
      return "unknown";
  }
}

/** Whether a tool name refers to the ask-user-question tool, in any namespace. */
export function isAskTool(toolName: string): boolean {
  const normalized = toolName
    .trim()
    .toLowerCase()
    .replace(/^(?:functions|tools)\./, "")
    .replace(/^mcp__.*?__/, "")
    .replace(/^mcp_/, "");
  return normalized === "ask";
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

export function normalizePiToolName(toolName: string): string {
  return toolName
    .trim()
    .toLowerCase()
    .replace(/^(?:functions|tools)\./, "")
    .replace(/^mcp__.*?__/, "")
    .replace(/^mcp_/, "");
}

export function isSubagentSupervisorTool(toolName: string): boolean {
  return normalizePiToolName(toolName) === "subagent_supervisor";
}

export function isBgWaitTool(toolName: string): boolean {
  return normalizePiToolName(toolName) === "bg_wait";
}

export type SubagentSupervisorAction = "reply" | "pending" | "list" | "status" | string;

export interface SubagentSupervisorInput {
  action: SubagentSupervisorAction;
  replyTo?: string;
  message?: string;
  to?: string;
}

export interface BgWaitInput {
  id?: string;
  all?: boolean;
  nonBlocking?: boolean;
  timeoutMs?: number;
  stopOnAttention?: boolean;
}

export interface PiToolTextEnvelope {
  text: string;
  details?: Record<string, unknown>;
}

function decodeToolInput(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    const parsed = parseJsonString(value);
    return isRecord(parsed) ? parsed : undefined;
  }
  return isRecord(value) ? value : undefined;
}

export function parseSubagentSupervisorInput(input: unknown): SubagentSupervisorInput {
  const record = decodeToolInput(input) ?? {};
  const action = typeof record.action === "string" && record.action.trim() ? record.action.trim().toLowerCase() : "";
  const replyTo = typeof record.replyTo === "string" && record.replyTo.trim() ? record.replyTo : undefined;
  const message = typeof record.message === "string" && record.message.trim() ? record.message : undefined;
  const to = typeof record.to === "string" && record.to.trim() ? record.to : undefined;
  return { action, ...(replyTo ? { replyTo } : {}), ...(message ? { message } : {}), ...(to ? { to } : {}) };
}

export function parseBgWaitInput(input: unknown): BgWaitInput {
  const record = decodeToolInput(input) ?? {};
  const id = typeof record.id === "string" && record.id.trim() ? record.id : undefined;
  const all = typeof record.all === "boolean" ? record.all : undefined;
  const nonBlocking = typeof record.nonBlocking === "boolean" ? record.nonBlocking : undefined;
  const timeoutMs = typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs) && record.timeoutMs > 0 ? record.timeoutMs : undefined;
  const stopOnAttention = typeof record.stopOnAttention === "boolean" ? record.stopOnAttention : undefined;
  return { ...(id ? { id } : {}), ...(all !== undefined ? { all } : {}), ...(nonBlocking !== undefined ? { nonBlocking } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(stopOnAttention !== undefined ? { stopOnAttention } : {}) };
}

/** Extract the first text block and details record from a pi tool result envelope. */
export function extractPiToolText(output: unknown): PiToolTextEnvelope | undefined {
  if (typeof output === "string") {
    return output.trim() ? { text: output } : undefined;
  }
  if (!isRecord(output)) return undefined;
  const content = output.content;
  if (typeof content === "string" && content.trim()) {
    return { text: content, ...(isRecord(output.details) ? { details: output.details } : {}) };
  }
  if (Array.isArray(content)) {
    const texts = content.flatMap((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" && item.text.trim() ? [item.text] : []);
    if (texts.length > 0) {
      return { text: texts.join("\n"), ...(isRecord(output.details) ? { details: output.details } : {}) };
    }
  }
  if (isRecord(output.details)) return { text: "", details: output.details };
  return undefined;
}

export function shortRunId(value: string | undefined, length = 8): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > length ? trimmed.slice(0, length) : trimmed;
}

export function formatWaitTimeout(timeoutMs: number | undefined): string | undefined {
  if (timeoutMs === undefined) return undefined;
  const seconds = Math.round(timeoutMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder === 0 ? `${hours}h` : `${hours}h ${minuteRemainder}m`;
}

export function subagentSupervisorLabel(input: unknown): string {
  const parsed = parseSubagentSupervisorInput(input);
  switch (parsed.action) {
    case "reply":
      return "Supervisor Reply";
    case "pending":
      return "Supervisor Queue";
    case "list":
      return "Supervisor Requests";
    case "status":
      return "Supervisor Status";
    default:
      return "Subagent Supervisor";
  }
}

export function subagentSupervisorSummary(input: unknown, output: unknown): string | undefined {
  const parsed = parseSubagentSupervisorInput(input);
  if (parsed.action === "reply") {
    const envelope = extractPiToolText(output);
    const details = envelope?.details;
    const agent = typeof details?.agent === "string" && details.agent.trim() ? details.agent : undefined;
    const messageSummary = parsed.message ? compactText(parsed.message, 120) : undefined;
    const replyTarget = shortRunId(parsed.replyTo ?? (typeof details?.replyTo === "string" ? details.replyTo : undefined));
    const parts = [agent, messageSummary ?? (replyTarget ? `→ ${replyTarget}` : undefined)].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : replyTarget ? `→ ${replyTarget}` : undefined;
  }
  if (parsed.action === "pending" || parsed.action === "list" || parsed.action === "status") {
    const envelope = extractPiToolText(output);
    if (envelope?.text) return compactText(envelope.text.split("\n")[0] ?? "", 120);
    return parsed.to ? `→ ${parsed.to}` : undefined;
  }
  return parsed.message ? compactText(parsed.message, 120) : undefined;
}

export interface BgWaitCompletionSummary {
  runId: string;
  agent?: string;
  success?: boolean;
}

export interface BgWaitOutputSummary {
  text: string;
  headline?: string;
  body?: string;
  waitReason?: string;
  timedOut?: boolean;
  activeRunIds: string[];
  activeProviderItems: Array<{ provider: string; id: string }>;
  completions: BgWaitCompletionSummary[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

export function parseBgWaitOutput(output: unknown): BgWaitOutputSummary | undefined {
  const envelope = extractPiToolText(output);
  if (!envelope) return undefined;
  const details = envelope.details ?? {};
  const wait = isRecord(details.wait) ? details.wait : undefined;
  const waitReason = typeof wait?.reason === "string" ? wait.reason : undefined;
  const timedOut = typeof wait?.timedOut === "boolean" ? wait.timedOut : undefined;
  const activeRunIds = wait ? stringList(wait.activeRunIds) : [];
  const activeProviderItems = Array.isArray(wait?.activeProviderItems)
    ? (wait.activeProviderItems as unknown[]).flatMap((item) => isRecord(item) && typeof item.provider === "string" && typeof item.id === "string" ? [{ provider: item.provider, id: item.id }] : [])
    : [];
  const rawCompletions = Array.isArray(details.completions) ? (details.completions as unknown[]) : [];
  const completions: BgWaitCompletionSummary[] = rawCompletions.flatMap((completion) => {
    if (!isRecord(completion) || typeof completion.runId !== "string") return [];
    const runId = completion.runId;
    const results = Array.isArray(completion.results) ? (completion.results as unknown[]) : [];
    if (results.length === 0) return [{ runId }];
    return results.map((result) => {
      if (!isRecord(result)) return { runId };
      const agent = typeof result.agent === "string" ? result.agent : undefined;
      const success = typeof result.success === "boolean" ? result.success : undefined;
      return { runId, ...(agent ? { agent } : {}), ...(success !== undefined ? { success } : {}) };
    });
  });
  const lines = envelope.text.split("\n");
  const headline = lines[0]?.trim() ? lines[0].trim() : undefined;
  const body = lines.length > 1 && lines.slice(1).join("\n").trim() ? lines.slice(1).join("\n").trim() : undefined;
  return { text: envelope.text, ...(headline ? { headline } : {}), ...(body ? { body } : {}), ...(waitReason ? { waitReason } : {}), ...(timedOut !== undefined ? { timedOut } : {}), activeRunIds, activeProviderItems, completions };
}

export function bgWaitLabel(input: unknown): string {
  const parsed = parseBgWaitInput(input);
  if (parsed.nonBlocking === true) return "Wait Subscription";
  if (parsed.all === true) return "Wait for All";
  if (parsed.id) return "Wait for Run";
  return "Bg Wait";
}

export function bgWaitSummary(input: unknown, output: unknown): string | undefined {
  const parsed = parseBgWaitInput(input);
  const summary = parseBgWaitOutput(output);
  const target = parsed.id ? shortRunId(parsed.id) : parsed.all === true ? "all runs" : "next run";
  const timeout = formatWaitTimeout(parsed.timeoutMs);
  const header = [target, timeout ? `${timeout} timeout` : undefined].filter(Boolean).join(" · ");
  if (summary && summary.completions.length > 0) {
    const first = summary.completions[0];
    const completionLabel = first?.agent ?? shortRunId(first?.runId) ?? "run";
    const extra = summary.completions.length > 1 ? ` +${summary.completions.length - 1} more` : "";
    return `${completionLabel}${extra} done${header ? ` · ${header}` : ""}`;
  }
  if (summary?.waitReason === "window_elapsed") {
    return header ? `${header} · timed out` : "timed out";
  }
  if (summary?.waitReason === "supervisor_request") {
    return header ? `${header} · supervisor request` : "supervisor request";
  }
  if (summary?.headline) {
    const waiting = summary.headline.match(/waiting\s+([\d.]+s)/i)?.[1];
    if (waiting && header) return `${header} · waited ${waiting}`;
    if (waiting) return `waited ${waiting}`;
  }
  return header || undefined;
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

export const PREVIEW_LINES = 20;
export const PREVIEW_CHARS = 4_000;
export const MAX_FORMAT_CHARS = 100_000;
export const MAX_DIFF_CHARS = 100_000;

export interface TextPreview {
  text: string;
  truncated: boolean;
  totalLines: number;
  totalChars: number;
}

export function previewText(
  text: string,
  maxLines = PREVIEW_LINES,
  maxChars = PREVIEW_CHARS,
): TextPreview {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const totalChars = text.length;

  if (totalLines <= maxLines && totalChars <= maxChars) {
    return { text, truncated: false, totalLines, totalChars };
  }

  const candidate = text.slice(0, maxChars + 1);
  const candidateLines = candidate.split("\n");
  let preview = candidateLines.slice(0, maxLines).join("\n").slice(0, maxChars);

  // Guard against splitting a UTF-16 surrogate pair
  const last = preview.charCodeAt(preview.length - 1);
  const next = text.charCodeAt(preview.length);
  if (
    preview.length < text.length &&
    last >= 0xd800 &&
    last <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  ) {
    preview = preview.slice(0, -1);
  }

  return {
    text: preview,
    truncated: preview.length < text.length,
    totalLines,
    totalChars,
  };
}

function looksLikeJson(source: string): boolean {
  return /^\s*[[{"]/.test(source.slice(0, 256));
}

export interface JsonFormat {
  text: string | null;
  limited: boolean;
}

/** Change whitespace only. Preserve large numbers, key order, duplicate keys and escapes. */
export function formatJson(source: string): JsonFormat {
  if (source.length > MAX_FORMAT_CHARS || !source.trim()) {
    return { text: null, limited: source.length > MAX_FORMAT_CHARS && looksLikeJson(source) };
  }
  try {
    JSON.parse(source);
  } catch {
    return { text: null, limited: false };
  }
  const tokens = source.match(/"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g) ?? [];
  let depth = 0;
  const out: string[] = [];
  let length = 0;
  const push = (value: string) => {
    out.push(value);
    length += value.length;
  };
  const line = () => push("\n" + "  ".repeat(Math.min(depth, 40)));
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "{" || token === "[") {
      push(token);
      depth += 1;
      if (tokens[index + 1] !== "}" && tokens[index + 1] !== "]") line();
    } else if (token === "}" || token === "]") {
      depth -= 1;
      if (tokens[index - 1] !== "{" && tokens[index - 1] !== "[") line();
      push(token);
    } else if (token === ",") {
      push(token);
      line();
    } else if (token === ":") {
      push(": ");
    } else {
      push(token);
    }
    if (length > MAX_FORMAT_CHARS) return { text: null, limited: true };
  }
  return { text: out.join(""), limited: false };
}

export function prettyJson(source: string): string | null {
  return formatJson(source).text;
}

export function extractCodeInput(
  toolName: string,
  value: unknown,
): { code: string; language: string } | undefined {
  let decoded = value;
  if (typeof value === "string" && value.length <= 1_000_000) {
    try {
      decoded = JSON.parse(value);
    } catch {
      // may be literal JS
    }
  }
  const record =
    decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : undefined;
  const name = toolName
    .trim()
    .toLowerCase()
    .replace(/^(?:functions|tools)\./, "")
    .replace(/^mcp__.*?__/, "")
    .replace(/^mcp_/, "");

  const codeTool = ["exec", "mcpscript", "mcp_script", "run_script"].includes(name);
  if (codeTool) {
    const code =
      record?.code ??
      (typeof decoded === "string" && !decoded.slice(0, 256).trimStart().startsWith("{")
        ? decoded
        : undefined);
    if (typeof code === "string") {
      return { code, language: "javascript" };
    }
  }

  if (name === "evaluate_browser" || name === "browser_evaluate") {
    const code = record?.expression ?? record?.code;
    if (typeof code === "string") {
      return { code, language: "javascript" };
    }
  }

  return undefined;
}

export type ApplyPatchOperation = "add" | "delete" | "update";

export interface ApplyPatchEdit {
  filePath: string;
  operation: ApplyPatchOperation;
  unifiedDiff: string;
}

function parseJsonString(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function applyPatchInput(value: unknown): string | undefined {
  if (typeof value === "string") {
    const parsed = parseJsonString(value);
    return parsed === value ? value : applyPatchInput(parsed);
  }
  if (!isRecord(value)) return undefined;
  if (value.input !== undefined) {
    const nestedInput = applyPatchInput(value.input);
    if (nestedInput) return nestedInput;
  }
  for (const key of ["input", "patch", "patchText"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return undefined;
}

function applyPatchToolName(name: string): boolean {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/^(?:functions|tools)\./, "")
    .replace(/^mcp__.*?__/, "")
    .replace(/^mcp_/, "");
  return normalized === "apply_patch" || normalized === "apply-patch";
}

function patchInputEdits(input: string): ApplyPatchEdit[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const edits: ApplyPatchEdit[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = lines[index]?.match(/^\*\*\* (Add|Delete|Update) File: (.+)$/);
    if (!header?.[1] || !header[2]) {
      index++;
      continue;
    }

    const operation = header[1].toLowerCase() as ApplyPatchOperation;
    const filePath = header[2];
    index++;
    const diffLines: string[] = [];
    while (index < lines.length && !lines[index]?.match(/^\*\*\* (?:Add|Delete|Update) File: /)) {
      const line = lines[index] ?? "";
      if (operation === "add" && line.startsWith("+")) {
        diffLines.push(`+${line.slice(1)}`);
      } else if (operation === "update") {
        if (line.startsWith("@@")) diffLines.push(line);
        else if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) diffLines.push(line);
      }
      index++;
    }
    edits.push({ filePath, operation, unifiedDiff: diffLines.join("\n") });
  }
  return edits;
}

function unifiedDiffEdits(unifiedDiff: string, firstFilePath?: string): ApplyPatchEdit[] {
  const sections = unifiedDiff
    .replace(/\r\n?/g, "\n")
    .split(/(?=^diff --git )/m)
    .filter((section) => section.trim());
  const edits: ApplyPatchEdit[] = [];
  for (const [index, section] of sections.entries()) {
    const plusHeader = section.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1];
    const minusHeader = section.match(/^--- (?:a\/)?(.+)$/m)?.[1];
    const operation: ApplyPatchOperation = plusHeader === "/dev/null" ? "delete" : minusHeader === "/dev/null" ? "add" : "update";
    const filePath = index === 0 && firstFilePath ? firstFilePath : operation === "delete" ? minusHeader : plusHeader ?? minusHeader;
    if (!filePath || filePath === "/dev/null") continue;
    const body = section
      .split("\n")
      .filter((line) => line.startsWith("@@") || line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))
      .filter((line) => !line.startsWith("+++") && !line.startsWith("---"))
      .join("\n");
    edits.push({ filePath, operation, unifiedDiff: body });
  }
  return edits;
}

function previewDiffToUnifiedDiff(diff: string): string {
  return diff
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line, index, lines) => !(index === lines.length - 1 && line === ""))
    .map((line) => {
      const match = line.match(/^([+\- ])\s*\d+\s(.*)$/);
      return match?.[1] && match[2] !== undefined ? `${match[1]}${match[2]}` : line;
    })
    .join("\n");
}

function patchPreviewEdits(value: unknown): ApplyPatchEdit[] {
  if (!isRecord(value)) return [];
  const nested = [value, value.details, value.result].find((candidate) => {
    if (!isRecord(candidate)) return false;
    return isRecord(candidate.preview) || (isRecord(candidate.details) && isRecord(candidate.details.preview));
  });
  if (!isRecord(nested)) return [];
  const details = isRecord(nested.details) ? nested.details : nested;
  const preview = isRecord(details.preview) ? details.preview : undefined;
  const files = preview && Array.isArray(preview.files) ? preview.files : undefined;
  if (!files) return [];

  return files.flatMap((file): ApplyPatchEdit[] => {
    if (!isRecord(file) || typeof file.filePath !== "string") return [];
    const operation = file.operation;
    if (operation !== "add" && operation !== "delete" && operation !== "update") return [];
    return [{
      filePath: file.filePath,
      operation,
      unifiedDiff: typeof file.diff === "string" ? previewDiffToUnifiedDiff(file.diff) : "",
    }];
  });
}

export function extractApplyPatchEdits(input: unknown, output: unknown): ApplyPatchEdit[] {
  const outputEdits = patchPreviewEdits(output);
  if (outputEdits.length > 0) return outputEdits;
  if (isRecord(input) && input.type === "edit" && typeof input.unifiedDiff === "string") {
    return unifiedDiffEdits(input.unifiedDiff, typeof input.filePath === "string" ? input.filePath : undefined);
  }
  const inputText = applyPatchInput(input);
  if (inputText) {
    const parsed = patchInputEdits(inputText);
    if (parsed.length > 0) return parsed;
    if (inputText.includes("diff --git ")) return unifiedDiffEdits(inputText);
  }
  if (typeof output === "string" && output.includes("diff --git ")) return unifiedDiffEdits(output);
  return [];
}

export function isApplyPatchTool(toolName: string): boolean {
  return applyPatchToolName(toolName);
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

function splitDiffLines(text: string): { lines: string[]; hasTrailingNewline: boolean } {
  const normalized = text.replace(/\r/g, "");
  if (!normalized) return { lines: [], hasTrailingNewline: false };
  const hasTrailingNewline = normalized.endsWith("\n");
  const rawLines = normalized.split("\n");
  if (hasTrailingNewline) rawLines.pop();
  return { lines: rawLines, hasTrailingNewline };
}

function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  if (oldText.length + newText.length > MAX_DIFF_CHARS) {
    return [
      ...(oldText ? [{ kind: "remove" as const, text: `[Previous content: ${oldText.length.toLocaleString()} characters]` }] : []),
      ...(newText ? [{ kind: "add" as const, text: `[Updated content: ${newText.length.toLocaleString()} characters]` }] : []),
    ];
  }

  const { lines: oldLines, hasTrailingNewline: oldHasNewline } = splitDiffLines(oldText);
  const { lines: newLines, hasTrailingNewline: newHasNewline } = splitDiffLines(newText);
  const m = oldLines.length;
  const n = newLines.length;

  if (m === 0 && n === 0) return [];
  if (m === 0) return newLines.map((text) => ({ kind: "add", text }));
  if (n === 0) return oldLines.map((text) => ({ kind: "remove", text }));

  // Trim common prefix
  let start = 0;
  while (start < m && start < n && oldLines[start] === newLines[start]) {
    start++;
  }

  // Trim common suffix
  let oldEnd = m - 1;
  let newEnd = n - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  // If all lines matched but newline termination changed, mark the last line as updated
  if (start >= m && start >= n && oldHasNewline !== newHasNewline) {
    const lastLine = oldLines[m - 1] ?? "";
    const prefix = oldLines.slice(0, m - 1).map((text) => ({ kind: "context" as const, text }));
    return [...prefix, { kind: "remove", text: lastLine }, { kind: "add", text: lastLine }];
  }

  const prefix: DiffLine[] = oldLines.slice(0, start).map((text) => ({ kind: "context", text }));
  const suffix: DiffLine[] = oldLines.slice(oldEnd + 1).map((text) => ({ kind: "context", text }));

  const trimmedOld = oldLines.slice(start, oldEnd + 1);
  const trimmedNew = newLines.slice(start, newEnd + 1);

  const tM = trimmedOld.length;
  const tN = trimmedNew.length;

  if (tM === 0 && tN === 0) return prefix.concat(suffix);

  // If the trimmed region is oversized, fall back to coarse replacement to protect memory
  if (tM * tN > 500_000 || tM + tN > 2500) {
    const fallback: DiffLine[] = [
      ...trimmedOld.map((text) => ({ kind: "remove" as const, text })),
      ...trimmedNew.map((text) => ({ kind: "add" as const, text })),
    ];
    return prefix.concat(fallback, suffix);
  }

  const dp: number[][] = Array.from({ length: tM + 1 }, () =>
    Array.from({ length: tN + 1 }, () => 0),
  );
  for (let i = 0; i < tM; i++) {
    for (let j = 0; j < tN; j++) {
      if (trimmedOld[i] === trimmedNew[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const middle: DiffLine[] = [];
  let i = tM;
  let j = tN;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && trimmedOld[i - 1] === trimmedNew[j - 1]) {
      middle.push({ kind: "context", text: trimmedOld[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      middle.push({ kind: "add", text: trimmedNew[j - 1] });
      j--;
    } else if (i > 0) {
      middle.push({ kind: "remove", text: trimmedOld[i - 1] });
      i--;
    }
  }

  return prefix.concat(middle.reverse(), suffix);
}

function countLines(value: string): number {
  if (!value) return 0;
  const lines = value.replace(/\r/g, "").split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function diffStatsFromStrings(oldString: string, newString: string): DiffStats {
  if (oldString.length + newString.length > MAX_DIFF_CHARS) {
    return { additions: countLines(newString), deletions: countLines(oldString) };
  }
  let additions = 0;
  let deletions = 0;
  for (const line of computeLineDiff(oldString, newString)) {
    if (line.kind === "add") additions += 1;
    else if (line.kind === "remove") deletions += 1;
  }
  return { additions, deletions };
}

const DIFF_CONTEXT_LINES = 3;

function focusDiffChanges(lines: DiffLine[], contextLines = DIFF_CONTEXT_LINES): DiffLine[] {
  const changedIndexes = lines.flatMap((line, index) =>
    line.kind === "add" || line.kind === "remove" ? [index] : [],
  );
  if (changedIndexes.length === 0) return lines;

  const ranges: Array<{ start: number; end: number }> = [];
  for (const changedIndex of changedIndexes) {
    const range = {
      start: Math.max(0, changedIndex - contextLines),
      end: Math.min(lines.length, changedIndex + contextLines + 1),
    };
    const previous = ranges[ranges.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      ranges.push(range);
    }
  }

  const focused: DiffLine[] = [];
  for (const [index, range] of ranges.entries()) {
    if (index > 0) focused.push({ kind: "meta", text: "…" });
    if (range.start > 0 && index === 0) focused.push({ kind: "meta", text: "…" });
    focused.push(...lines.slice(range.start, range.end));
    if (range.end < lines.length && index === ranges.length - 1) {
      focused.push({ kind: "meta", text: "…" });
    }
  }
  return focused;
}

export function diffStatsForDetail(detail: Extract<ToolCallDetail, { type: "edit" }>): DiffStats {
  if (detail.unifiedDiff !== undefined) return diffStatsFromUnifiedDiff(detail.unifiedDiff);
  return diffStatsFromStrings(detail.oldString ?? "", detail.newString ?? "");
}

export function diffLinesForDetail(detail: Extract<ToolCallDetail, { type: "edit" }>): DiffLine[] {
  const size = (detail.unifiedDiff?.length ?? ((detail.oldString?.length ?? 0) + (detail.newString?.length ?? 0)));
  if (size > MAX_DIFF_CHARS) {
    return [
      ...(detail.oldString ? [{ kind: "remove" as const, text: `[Previous content: ${detail.oldString.length.toLocaleString()} characters]` }] : []),
      ...(detail.newString ? [{ kind: "add" as const, text: `[Updated content: ${detail.newString.length.toLocaleString()} characters]` }] : []),
    ];
  }

  if (detail.unifiedDiff !== undefined) {
    const lines: DiffLine[] = detail.unifiedDiff
      .replace(/\r/g, "")
      .split("\n")
      .filter((line, index, lines) => !(index === lines.length - 1 && line === ""))
      .map((line): DiffLine => {
        if (line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")) {
          return { kind: "meta", text: line };
        }
        if (line.startsWith("+")) return { kind: "add", text: line.slice(1) };
        if (line.startsWith("-")) return { kind: "remove", text: line.slice(1) };
        if (line.startsWith(" ")) return { kind: "context", text: line.slice(1) };
        return { kind: "context", text: line };
      });
    return focusDiffChanges(lines);
  }

  return focusDiffChanges(computeLineDiff(detail.oldString ?? "", detail.newString ?? ""));
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
        label: "Shell",
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
    case "edit": {
      const editSize =
        detail.unifiedDiff?.length ??
        ((detail.oldString?.length ?? 0) + (detail.newString?.length ?? 0));
      return {
        category: "file",
        icon: commonFileFields.fileIcon ?? "Pencil",
        label: "Edit File",
        summary: compactText(detail.filePath),
        ...(editSize <= MAX_DIFF_CHARS ? { diffStats: diffStatsForDetail(detail) } : {}),
        ...commonFileFields,
      };
    }
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
      if (name === "ls") {
        return { category: "file", icon: "List", label: "List Files" };
      }
      if (name === "task") {
        return { category: "agent", icon: "Bot", label: "Task", summary: compactText(item.name) };
      }
      if (isAskTool(item.name)) {
        return { category: "communication", icon: "MessageCircleQuestionMark", label: "Ask Question" };
      }
      if (name === "speak") {
        return { category: "communication", icon: "MicVocal", label: "Speak" };
      }
      if (isSubagentSupervisorTool(item.name)) {
        return {
          category: "agent",
          icon: "Reply",
          label: subagentSupervisorLabel(detail.input),
          summary: subagentSupervisorSummary(detail.input, detail.output),
        };
      }
      if (isBgWaitTool(item.name)) {
        return {
          category: "agent",
          icon: "Hourglass",
          label: bgWaitLabel(detail.input),
          summary: bgWaitSummary(detail.input, detail.output),
        };
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
  if (normalized === "ls") {
    return { icon: "List", label: "List Files" };
  }
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
    return { icon: "SquareTerminal", label: "Shell" };
  }
  if (normalized === "edit" || normalized.includes("edit_file") || normalized.includes("patch")) {
    return { icon: "Pencil", label: "Edit File", summaryIcon: fileIconForPath(summary) };
  }
  if (normalized === "write" || normalized.includes("write_file") || normalized.includes("writefile")) {
    return { icon: "Pencil", label: "Write File", summaryIcon: fileIconForPath(summary) };
  }
  if (normalized === "task" || normalized.includes("sub_agent") || normalized.includes("subagent")) {
    if (normalized === "subagent_supervisor") {
      return { icon: "Reply", label: "Supervisor Reply" };
    }
    return { icon: "Bot", label: "Agent Task" };
  }
  if (normalized === "bg_wait" || normalized.includes("bg_wait")) {
    return { icon: "Hourglass", label: "Wait for Background Work" };
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

export function parsePiLsOutput(value: unknown): string[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content)) return null;

  const textBlocks = content.flatMap((block) => {
    if (block === null || typeof block !== "object" || Array.isArray(block)) return [];
    const record = block as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  });
  if (textBlocks.length !== content.length) return null;

  return textBlocks.flatMap((text) => text.split("\n").filter((entry) => entry.length > 0));
}

export function readErrorMessage(content: string | undefined): string | undefined {
  const text = content?.trim();
  return text && /^(?:E[A-Z0-9_]+|Error):\s/.test(text) ? text : undefined;
}

export function formatUnknownValue(value: unknown): string {
  if (typeof value === "string") {
    const formatted = prettyJson(value);
    return formatted ?? value;
  }
  try {
    const raw = JSON.stringify(value);
    if (raw === undefined) return String(value);
    const formatted = prettyJson(raw);
    return formatted ?? JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatError(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  if (typeof error === "object" && !Array.isArray(error)) {
    const content = (error as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      const text = content
        .filter((part): part is { type: "text"; text: string } =>
          part !== null &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          (part as Record<string, unknown>).type === "text" &&
          typeof (part as Record<string, unknown>).text === "string",
        )
        .map((part) => part.text)
        .join("\n");
      if (text) return compactText(text, 400);
    }
  }
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

/**
 * Split reasoning prose into steps on blank-line runs, mirroring how a reader
 * scans paragraphs. Single-paragraph text yields one step so short thoughts
 * render without step chrome.
 */
export function splitReasoningSteps(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
}

/** Rough token estimate (4 chars per token) for header counts. */
export function estimateReasoningTokens(text: string): number {
  if (!text) return 0;
  return Math.round(text.length / 4);
}

/** Quiet header metadata: "2 steps · 116 tokens". Steps are omitted when zero. */
export function formatReasoningMeta(stepCount: number, tokenCount: number): string {
  const tokens = `${tokenCount.toLocaleString("en-US")} token${tokenCount === 1 ? "" : "s"}`;
  if (stepCount <= 0) return tokens;
  return `${stepCount.toLocaleString("en-US")} step${stepCount === 1 ? "" : "s"} · ${tokens}`;
}
