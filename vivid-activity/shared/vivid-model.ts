import { t, type MessageId } from "./text";

/** Getters preserve the public tables while looking up text in the current language.
 * The closure is created in its own call, never over a loop binding (Hermes eval).
 */
function textProperty(id: MessageId): PropertyDescriptor {
  return { enumerable: true, get: () => t(id) };
}
function translatedTable<T extends string>(ids: Record<T, MessageId>): Record<T, string> {
  const result = {} as Record<T, string>;
  for (const name of Object.keys(ids) as T[]) Object.defineProperty(result, name, textProperty(ids[name]));
  return result;
}

/**
 * 本地补丁（vivid-activity）的纯数据部分：类别外观、状态外观、中文标签、MCP 名称拆分、等待批准的 callId。
 * 不依赖 react-native，供客户端组件和单元测试共用。色相名对应 client/kit.tsx 的 vivid palette。
 */
export type Hue = "blue" | "sky" | "cyan" | "teal" | "green" | "lime" | "amber" | "orange" | "red" | "pink" | "fuchsia" | "violet" | "indigo" | "gray";

/** waiting: a permission request on the row (等你批准); question: the row asks you something (等你回答, 0.6.0). */
export type RowStatus = "running" | "waiting" | "question" | "completed" | "failed" | "canceled";
export type LookKey = "think" | "read" | "list" | "edit" | "write" | "shell" | "search" | "web" | "browser" | "agent" | "plan" | "mcp" | "paseo" | "ask" | "skill" | "other";

/**
 * 类别色与 Agent 观测台（agent-observatory 的 laneLooks / kindLooks）一致：思考紫、读文件蓝、搜索靛、改文件绿、
 * 命令橙、联网青、子 Agent 品红、计划蓝绿、等审批琥珀、其他灰。观测台没有的类别用它没占用的色相：
 * MCP 粉、Paseo 天蓝、技能黄绿（技能浏览器同样用 Sparkles）；提问也是「在等你」，与等审批同为琥珀。
 */
export const looks: Record<LookKey, { label: string; icon: string; hue: Hue }> = {
  think: { get label() { return t("modelLook.think"); }, icon: "Brain", hue: "violet" },
  read: { get label() { return t("modelLook.read"); }, icon: "FileText", hue: "blue" },
  list: { get label() { return t("modelLook.list"); }, icon: "FolderOpen", hue: "blue" },
  edit: { get label() { return t("modelLook.edit"); }, icon: "FilePen", hue: "green" },
  write: { get label() { return t("modelLook.write"); }, icon: "FilePlus", hue: "green" },
  shell: { get label() { return t("modelLook.shell"); }, icon: "SquareTerminal", hue: "orange" },
  search: { get label() { return t("modelLook.search"); }, icon: "Search", hue: "indigo" },
  web: { get label() { return t("modelLook.web"); }, icon: "Globe", hue: "cyan" },
  // 0.11.0:Paseo 内置浏览器工具（导航/点击/输入/快照……）独立类目；与网页同青色系，计数与色带分开。
  browser: { get label() { return t("modelLook.browser"); }, icon: "AppWindow", hue: "cyan" },
  agent: { get label() { return t("modelLook.agent"); }, icon: "Bot", hue: "fuchsia" },
  plan: { get label() { return t("modelLook.plan"); }, icon: "ListChecks", hue: "teal" },
  ask: { get label() { return t("modelLook.ask"); }, icon: "MessageCircleQuestionMark", hue: "amber" },
  mcp: { get label() { return t("modelLook.mcp"); }, icon: "Plug", hue: "pink" },
  paseo: { get label() { return t("modelLook.paseo"); }, icon: "Workflow", hue: "sky" },
  skill: { get label() { return t("modelLook.skill"); }, icon: "Sparkles", hue: "lime" },
  other: { get label() { return t("modelLook.other"); }, icon: "Puzzle", hue: "gray" },
};

/**
 * 0.5.0：「鲜明」调色板里上游详情视图的类别色（shared/presentation.ts 的 ActivityCategory）。图标色和底色都从这一张表取，
 * 不再各写一份：0.4 的子 Agent 图标是品红、底色却写成了绿色。null 是「其他」，用主题的弱前景色和 surface2。
 */
export const VIVID_CATEGORY_HUES = {
  reasoning: looks.think.hue,
  shell: looks.shell.hue,
  file: looks.read.hue,
  search: looks.search.hue,
  agent: looks.agent.hue,
  plan: looks.plan.hue,
  communication: looks.mcp.hue,
  unknown: null,
} as const satisfies Record<string, Hue | null>;

/** 本地补丁：折叠摘要里的类别计数名，与行标题一致（读取、编辑、命令……）。 */
export const COUNT_LABELS: Record<LookKey, string> = translatedTable({
  think: "modelCount.think", read: "modelCount.read", list: "modelCount.list", edit: "modelCount.edit", write: "modelCount.write", shell: "modelCount.shell", search: "modelCount.search", web: "modelCount.web",
  agent: "modelCount.agent", plan: "modelCount.plan", ask: "modelCount.ask", mcp: "modelCount.mcp", paseo: "modelCount.paseo", skill: "modelCount.skill", browser: "modelCount.browser", other: "modelCount.other",
});

export function isLookKey(value: string): value is LookKey {
  return Object.prototype.hasOwnProperty.call(looks, value);
}

export const statusLooks: Record<RowStatus, { label: string; hue: Hue | "muted"; icon: string }> = {
  running: { get label() { return t("modelRowStatus.running"); }, hue: "blue", icon: "LoaderCircle" },
  waiting: { get label() { return t("modelRowStatus.waiting"); }, hue: "amber", icon: "Hand" },
  question: { get label() { return t("modelRowStatus.question"); }, hue: "amber", icon: "MessageCircleQuestionMark" },
  completed: { get label() { return t("modelRowStatus.completed"); }, hue: "green", icon: "Check" },
  failed: { get label() { return t("modelRowStatus.failed"); }, hue: "red", icon: "X" },
  canceled: { get label() { return t("modelRowStatus.canceled"); }, hue: "muted", icon: "CircleSlash2" },
};

/** Paseo 自带工具（mcp__paseo__*）的中文名，键是上游 PASEO_TOOL_LABELS 的英文名。 */
export const PASEO_TOOL_ZH: Readonly<Record<string, string>> = translatedTable({
  "Speak": "modelPaseo.speak",
  "Create Workspace": "modelPaseo.createWorkspace",
  "List Workspaces": "modelPaseo.listWorkspaces",
  "Archive Workspace": "modelPaseo.archiveWorkspace",
  "Rename Workspace": "modelPaseo.renameWorkspace",
  "Create Agent": "modelPaseo.createAgent",
  "Send Agent Prompt": "modelPaseo.sendAgentPrompt",
  "Get Agent Status": "modelPaseo.getAgentStatus",
  "Get Agent Activity": "modelPaseo.getAgentActivity",
  "List Agents": "modelPaseo.listAgents",
  "Cancel Agent Run": "modelPaseo.cancelAgentRun",
  "Archive Agent": "modelPaseo.archiveAgent",
  "Kill Agent": "modelPaseo.killAgent",
  "Update Agent": "modelPaseo.updateAgent",
  "Set Agent Session Mode": "modelPaseo.setAgentSessionMode",
  "List Pending Permissions": "modelPaseo.listPendingPermissions",
  "Respond to Permission": "modelPaseo.respondToPermission",
  "List Workspace Scripts": "modelPaseo.listWorkspaceScripts",
  "Start Workspace Script": "modelPaseo.startWorkspaceScript",
  "Stop Workspace Script": "modelPaseo.stopWorkspaceScript",
  "List Terminals": "modelPaseo.listTerminals",
  "Create Terminal": "modelPaseo.createTerminal",
  "Kill Terminal": "modelPaseo.killTerminal",
  "Capture Terminal": "modelPaseo.captureTerminal",
  "Send Terminal Keys": "modelPaseo.sendTerminalKeys",
  "Create Schedule": "modelPaseo.createSchedule",
  "Create Heartbeat": "modelPaseo.createHeartbeat",
  "Delete Heartbeat": "modelPaseo.deleteHeartbeat",
  "List Schedules": "modelPaseo.listSchedules",
  "Inspect Schedule": "modelPaseo.inspectSchedule",
  "Pause Schedule": "modelPaseo.pauseSchedule",
  "Resume Schedule": "modelPaseo.resumeSchedule",
  "Delete Schedule": "modelPaseo.deleteSchedule",
  "Update Schedule": "modelPaseo.updateSchedule",
  "Schedule Logs": "modelPaseo.scheduleLogs",
  "Run Schedule Once": "modelPaseo.runScheduleOnce",
  "List Providers": "modelPaseo.listProviders",
  "List Models": "modelPaseo.listModels",
  "List Agent Profiles": "modelPaseo.listAgentProfiles",
  "Inspect Provider": "modelPaseo.inspectProvider",
  "List Browser Tabs": "modelPaseo.listBrowserTabs",
  "Browser List Tabs": "modelPaseo.listBrowserTabs",
  "Browser New Tab": "modelPaseo.createBrowserTab",
  "Browser Close Tab": "modelPaseo.closeBrowserTab",
  "Browser Snapshot": "modelPaseo.snapshotBrowserPage",
  "Browser Snapshot Page": "modelPaseo.snapshotBrowserPage",
  "Browser Click": "modelPaseo.clickBrowserElement",
  "Browser Click Element": "modelPaseo.clickBrowserElement",
  "Browser Fill": "modelPaseo.fillBrowserElement",
  "Browser Fill Element": "modelPaseo.fillBrowserElement",
  "Browser Hover": "modelPaseo.hoverBrowserElement",
  "Browser Hover Element": "modelPaseo.hoverBrowserElement",
  "Browser Drag": "modelPaseo.dragBrowserElement",
  "Browser Drag Element": "modelPaseo.dragBrowserElement",
  "Browser Select": "modelPaseo.selectBrowserOption",
  "Browser Select Option": "modelPaseo.selectBrowserOption",
  "Browser Wait": "modelPaseo.waitForBrowserCondition",
  "Browser Wait for Condition": "modelPaseo.waitForBrowserCondition",
  "Browser Type": "modelPaseo.typeIntoBrowser",
  "Browser Type into Element": "modelPaseo.typeIntoBrowser",
  "Browser Press Key": "modelPaseo.pressBrowserKey",
  "Browser Press": "modelPaseo.pressBrowserKey",
  "Browser Navigate": "modelPaseo.navigateBrowser",
  "Browser Scroll": "modelPaseo.scrollBrowser",
  "Browser Scroll Page": "modelPaseo.scrollBrowser",
  "Browser Resize": "modelPaseo.resizeBrowserViewport",
  "Browser Resize Viewport": "modelPaseo.resizeBrowserViewport",
  "Browser Screenshot": "modelPaseo.captureBrowserScreenshot",
  "Browser Capture Screenshot": "modelPaseo.captureBrowserScreenshot",
  "Browser Upload": "modelPaseo.uploadFilesInBrowser",
  "Browser Upload Files": "modelPaseo.uploadFilesInBrowser",
  "Browser Logs": "modelPaseo.readBrowserLogs",
  "Browser Read Logs": "modelPaseo.readBrowserLogs",
  "Browser Console": "modelPaseo.readBrowserLogs",
  "Browser Evaluate": "modelPaseo.evaluateBrowserJavascript",
  "Browser Evaluate JavaScript": "modelPaseo.evaluateBrowserJavascript",
  "Browser Key Press": "modelPaseo.pressBrowserKey",
  "Create Browser Tab": "modelPaseo.createBrowserTab",
  "Close Browser Tab": "modelPaseo.closeBrowserTab",
  "Snapshot Browser Page": "modelPaseo.snapshotBrowserPage",
  "Click Browser Element": "modelPaseo.clickBrowserElement",
  "Fill Browser Element": "modelPaseo.fillBrowserElement",
  "Hover Browser Element": "modelPaseo.hoverBrowserElement",
  "Drag Browser Element": "modelPaseo.dragBrowserElement",
  "Select Browser Option": "modelPaseo.selectBrowserOption",
  "Wait for Browser Condition": "modelPaseo.waitForBrowserCondition",
  "Type into Browser": "modelPaseo.typeIntoBrowser",
  "Press Browser Key": "modelPaseo.pressBrowserKey",
  "Navigate Browser": "modelPaseo.navigateBrowser",
  "Browser Back": "modelPaseo.browserBack",
  "Browser Forward": "modelPaseo.browserForward",
  "Browser Reload": "modelPaseo.browserReload",
  "Capture Browser Screenshot": "modelPaseo.captureBrowserScreenshot",
  "Upload Files in Browser": "modelPaseo.uploadFilesInBrowser",
  "Read Browser Logs": "modelPaseo.readBrowserLogs",
  "Evaluate Browser JavaScript": "modelPaseo.evaluateBrowserJavascript",
  "Scroll Browser": "modelPaseo.scrollBrowser",
  "Resize Browser Viewport": "modelPaseo.resizeBrowserViewport",
});

/** 上游英文标签 → 中文（行标题、详情小节名）。原始工具名（MCP 工具、未知工具）属于数据，保留原文。 */
const LABELS: Record<string, string> = translatedTable({
  "Read": "modelLabel.read", "List": "modelLabel.list", "List Directory": "modelLabel.listDirectory", "Edit": "modelLabel.edit", "Add": "modelLabel.add", "Delete": "modelLabel.delete", "Write": "modelLabel.write",
  "Shell": "modelLabel.shell", "Search": "modelLabel.search", "Find": "modelLabel.find", "Fetch URL": "modelLabel.fetchUrl", "Agent Task": "modelLabel.agentTask", "Plan": "modelLabel.plan", "Thinking": "modelLabel.thinking",
  "Skill": "modelLabel.skill", "Tasks": "modelLabel.tasks", "Ask Question": "modelLabel.askQuestion", "Background Task": "modelLabel.backgroundTask", "Speak": "modelLabel.speak", "Worktree Setup": "modelLabel.worktreeSetup", "Tool": "modelLabel.tool",
  "Search Tools": "modelLabel.searchTools", "Code Mode": "modelLabel.codeMode",
  "Supervisor Reply": "modelLabel.supervisorReply", "Supervisor Queue": "modelLabel.supervisorQueue", "Supervisor Requests": "modelLabel.supervisorRequests",
  "Supervisor Status": "modelLabel.supervisorStatus", "Subagent Supervisor": "modelLabel.subagentSupervisor",
  "Wait": "modelLabel.wait", "Wait for Background Work": "modelLabel.waitForBackgroundWork", "Wait Subscription": "modelLabel.waitSubscription", "Wait for All": "modelLabel.waitForAll",
  "Wait for Run": "modelLabel.waitForRun", "Bg Wait": "modelLabel.bgWait", "Wait for Agent": "modelLabel.waitForAgent",
  // 0.5.0: Pi's sub-agent tools (shared/pi-subagents.ts piSubagentPresentation).
  "Dispatch Agent": "modelLabel.dispatchAgent", "Steer Agent": "modelLabel.steerAgent", "Check Agent Result": "modelLabel.checkAgentResult", "Agent Result": "modelLabel.agentResult",
  "GitHub Actions Details": "modelLabel.gitHubActionsDetails", "GitHub Actions List": "modelLabel.gitHubActionsList", "GitHub Actions Run": "modelLabel.gitHubActionsRun",
  "GitHub File": "modelLabel.gitHubFile", "GitHub Job Logs": "modelLabel.gitHubJobLogs", "GitHub Pull Request": "modelLabel.gitHubPullRequest", "GitHub Code Search": "modelLabel.gitHubCodeSearch",
  "GitHub Repository Search": "modelLabel.gitHubRepositorySearch",
  "Exa Web Search": "modelLabel.exaWebSearch", "Exa Web Fetch": "modelLabel.exaWebFetch", "Exa Agent": "modelLabel.exaAgent",
  "Exa Research Guide": "modelLabel.exaResearchGuide", "Exa Schema Templates": "modelLabel.exaSchemaTemplates",
  // Claude Code tools Paseo has no detail type for (shown by name, e.g. inside a child agent's live activity).
  "TodoWrite": "modelLabel.todoWrite", "NotebookEdit": "modelLabel.notebookEdit", "BashOutput": "modelLabel.bashOutput", "KillShell": "modelLabel.killShell", "KillBash": "modelLabel.killBash",
  "WebSearch": "modelLabel.webSearch", "ExitPlanMode": "modelLabel.exitPlanMode", "EnterPlanMode": "modelLabel.enterPlanMode", "SlashCommand": "modelLabel.slashCommand", "AskUserQuestion": "modelLabel.askUserQuestion",
  "ListMcpResourcesTool": "modelLabel.listMcpResourcesTool", "ReadMcpResourceTool": "modelLabel.readMcpResourceTool",
  // Detail section labels.
  "Command": "modelLabel.command", "Output": "modelLabel.output", "Contents": "modelLabel.contents", "Written contents": "modelLabel.writtenContents", "Before": "modelLabel.before", "After": "modelLabel.after", "Diff": "modelLabel.diff",
  "Result": "modelLabel.result", "Error": "modelLabel.error", "Input": "modelLabel.input", "Image": "modelLabel.image", "Setup log": "modelLabel.setupLog", "Activity log": "modelLabel.activityLog", "Query": "modelLabel.query",
  "Matches": "modelLabel.matches", "Files": "modelLabel.files", "Message": "modelLabel.message", "Prompt": "modelLabel.prompt", "Code": "modelLabel.code", "Session": "modelLabel.session",
});

const WAIT_FOR_AGENTS = /^Wait for (\d+) Agents$/;

export function zh(label: string): string {
  const direct = LABELS[label];
  if (direct) return direct;
  if (label.startsWith("Paseo ")) {
    const paseo = PASEO_TOOL_ZH[label.slice("Paseo ".length)];
    if (paseo) return t("modelText.paseoLabel", { label: paseo });
  }
  const agents = WAIT_FOR_AGENTS.exec(label);
  if (agents) return t("modelText.waitAgents", { count: agents[1] });
  return label;
}

type DetailLike = { type?: unknown; toolName?: unknown } | null | undefined;

/** Which look a row gets: detail type first (like the observatory's tool kinds), then well-known tool names. */
export function lookFor(name: string, detail: DetailLike, presentation: { category: string; label: string; icon: string }): LookKey {
  const leaf = name.trim().toLowerCase();
  const detailType = typeof detail?.type === "string" ? detail.type : "unknown";
  if (detailType === "shell" || detailType === "worktree_setup") return "shell";
  if (detailType === "read") return presentation.label === "List" ? "list" : "read";
  if (detailType === "edit") return presentation.label === "Add" ? "write" : "edit";
  if (detailType === "write") return "write";
  if (detailType === "search") return detail?.toolName === "web_search" ? "web" : "search";
  if (detailType === "fetch") return "web";
  if (detailType === "sub_agent") return "agent";
  if (detailType === "plan") return "plan";
  if (presentation.label === "Skill") return "skill";
  if (presentation.label === "Ask Question") return "ask";
  if (presentation.label === "Tasks") return "plan";
  if (presentation.label.startsWith("Paseo ")) return "paseo";
  if (presentation.label === "Exa Web Search" || presentation.label === "Exa Web Fetch") return "web";
  // 0.11.0:浏览器工具独立类目——判据用名称本身（browser_* 及宿主标题化变体 "Browser X" 都命中），
  // 不锚定图标表：宿主改标签名（0.15 把 Create Browser Tab 改成 Browser New Tab）也不会失效。
  // 含 browser 的 MCP 工具也归此（它们确实是浏览器操作）。
  if (/browser/i.test(leaf)) return "browser";
  if (/^mcp__|^mcp_|\./.test(leaf) && presentation.category === "unknown") return "mcp";
  if (presentation.category === "search") return "search";
  if (presentation.category === "agent") return "agent";
  if (presentation.category === "shell") return "shell";
  if (presentation.category === "plan") return "plan";
  return "other";
}

/**
 * `mcp__github__search_code` → { server: "github", tool: "search_code" }: the server up to the first `__` after it, as
 * `/^mcp__(.+?)__(.+)$/` read it. 0.6.0-local.2 (codex-vivid-F1): found by index; the lazy regex retried past every later
 * `__` when the name held a line break.
 */
export function mcpParts(name: string): { server: string; tool: string } | null {
  const trimmed = name.trim();
  const at = trimmed.startsWith("mcp__") && !/[\n\r\u2028\u2029]/.test(trimmed) ? trimmed.indexOf("__", 6) : -1;
  return at >= 0 && at + 2 < trimmed.length ? { server: trimmed.slice(5, at), tool: trimmed.slice(at + 2) } : null;
}

type PendingLike = { kind?: unknown; metadata?: Record<string, unknown> } | null | undefined;
/**
 * Where a permission request names the timeline row it belongs to: Claude `metadata.toolUseId`, ACP `metadata.toolCallId`,
 * Codex app-server `metadata.itemId` (0.6.0, opus-F48: its command, file-change and request_user_input requests carry only the
 * item id, and the row's callId is that same item.id), OpenCode questions `metadata.callID`. Each equals the row's callId.
 */
const ROW_ID_KEYS = ["toolUseId", "toolCallId", "itemId", "callID"] as const;

function rowIdsOf(request: PendingLike): string[] {
  const meta = request?.metadata ?? {};
  return ROW_ID_KEYS.map((key) => meta[key]).filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function pendingCallIds(pending: readonly PendingLike[] | null | undefined): ReadonlySet<string> {
  return pendingCalls(pending).ids;
}

/**
 * 0.6.0 (opus-F54): the rows waiting for you, and which of them ask a question (`kind: "question"`: Claude's
 * AskUserQuestion, Codex request_user_input, OpenCode/Pi/OMP questions) rather than ask for approval. `onlyQuestions`:
 * every pending request is a question, for a row that cannot be matched by id.
 */
export function pendingCalls(pending: readonly PendingLike[] | null | undefined): { ids: ReadonlySet<string>; questions: ReadonlySet<string>; onlyQuestions: boolean } {
  const ids = new Set<string>();
  const questions = new Set<string>();
  let onlyQuestions = (pending?.length ?? 0) > 0;
  for (const request of pending ?? []) {
    const question = request?.kind === "question";
    if (!question) onlyQuestions = false;
    for (const id of rowIdsOf(request)) {
      ids.add(id);
      if (question) questions.add(id);
    }
  }
  return { ids, questions, onlyQuestions };
}

/**
 * 本地补丁：哪些动效组件需要挂载。motion.tsx 的每个动效组件都会各自注册「减弱动态效果」（和前后台）监听，
 * 并在挂载时查询一次系统设置；上游行头给每一行都挂了 Pop/Flash。这里只给真正在动的行挂：运行中的转圈与扫光、
 * 等你批准的波纹、直播中的呼吸，以及「你看着它变了」之后的弹出与闪光。静止的已完成行一个也不挂。
 */
export function rowMotion(input: { status: RowStatus; statusChanges: number; finishes: number; live: boolean }) {
  return {
    spin: input.status === "running",
    sweep: input.status === "running",
    ping: input.status === "waiting" || input.status === "question",
    breathe: input.live,
    pop: input.statusChanges > 0,
    flash: input.status === "completed" && input.finishes > 0,
  };
}

/** Row wash behind live and attention states; light themes need a little more tint to read on white. */
export function washAlpha(status: RowStatus, dark: boolean): number {
  if (status !== "running" && status !== "waiting" && status !== "question" && status !== "failed") return 0;
  return dark ? 0.14 : 0.1;
}

// 本地补丁：状态值保持英文（决定颜色），显示时换成中文。精确匹配优先（「Active」是浏览器当前标签页）。
const STATUS_ZH: Readonly<Record<string, string>> = translatedTable({
  "Active": "modelStatus.exactActive", "Default": "modelStatus.exactDefault", "Success": "modelStatus.exactSuccess", "Failed": "modelStatus.exactFailed",
  "running": "modelStatus.running", "initializing": "modelStatus.initializing", "starting": "modelStatus.starting", "loading": "modelStatus.loading", "completed": "modelStatus.completed", "succeeded": "modelStatus.succeeded",
  "success": "modelStatus.success", "idle": "modelStatus.idle", "active": "modelStatus.active", "healthy": "modelStatus.healthy", "ready": "modelStatus.ready", "available": "modelStatus.available", "enabled": "modelStatus.enabled",
  "failed": "modelStatus.failed", "error": "modelStatus.error", "unhealthy": "modelStatus.unhealthy", "unavailable": "modelStatus.unavailable", "disabled": "modelStatus.disabled", "canceled": "modelStatus.canceled",
  "cancelled": "modelStatus.cancelled", "paused": "modelStatus.paused", "stopped": "modelStatus.stopped", "closed": "modelStatus.closed", "exited": "modelStatus.exited", "archived": "modelStatus.archived",
  "expired": "modelStatus.expired", "skipped": "modelStatus.skipped", "pending": "modelStatus.pending", "queued": "modelStatus.queued", "timeout": "modelStatus.timeout", "timed_out": "modelStatus.timedOut",
  "worktree": "modelStatus.worktree", "local": "modelStatus.local", "none": "modelStatus.none", "directory": "modelStatus.directory",
  "tool": "modelStatus.tool", "plan": "modelStatus.plan", "question": "modelStatus.question", "mode": "modelStatus.mode", "other": "modelStatus.other",
  "finished": "modelStatus.finished", "permission": "modelStatus.permission", "closed_by_user": "modelStatus.closedByUser",
  "background": "modelStatus.background",
});
export function statusLabel(value: string): string {
  return STATUS_ZH[value] ?? STATUS_ZH[value.toLowerCase()] ?? value;
}

/**
 * A failed command's exit code when known, else null. Codex/ACP report `exitCode` on the detail; Claude Code only puts
 * it in the error text ("Exit code 1\n…"). 0.8.0: shared by the row's state pill and the fold index (shared/changes.ts).
 */
export function exitCodeOf(detail: { type?: unknown; exitCode?: unknown } | null | undefined, errorText: string | undefined): number | null {
  const fromDetail = detail?.type === "shell" && typeof detail.exitCode === "number" && Number.isInteger(detail.exitCode) && detail.exitCode !== 0 ? detail.exitCode : null;
  const fromText = /^\s*Exit code (\d{1,9})\b/i.exec(errorText ?? "")?.[1];
  const code = fromDetail ?? (fromText ? Number(fromText) : null);
  return code !== null && code !== 0 ? code : null;
}

/** Words for a failed row's state pill: the shell exit code when known. */
export function failureText(detail: { type?: unknown; exitCode?: unknown } | null | undefined, errorText: string | undefined): string | undefined {
  const code = exitCodeOf(detail, errorText);
  return code !== null ? t("modelText.exitCode", { code }) : undefined;
}

/** Screen-reader label: action, what it touched (the path as shown), and the state when it needs attention. */
export function rowLabel({ expanded, title, summary, fileDisplay, status }: { expanded: boolean; title: string; summary?: string; fileDisplay?: { dir?: string; base: string }; status?: RowStatus }): string {
  const target = fileDisplay ? (fileDisplay.dir ? `${fileDisplay.dir}/${fileDisplay.base}` : fileDisplay.base) : summary;
  const state = status === "waiting" || status === "question" || status === "failed" || status === "running" ? t("modelText.stateSuffix", { state: statusLooks[status].label }) : "";
  return t(expanded ? "modelText.collapseRow" : "modelText.expandRow", { title, target: target ? t("modelText.rowTarget", { target }) : "", state });
}
