import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import {
  createReasoningData,
  createTodoData,
  createToolCallData,
  type ReasoningItemData,
  type TodoItemData,
  type ToolCallItemData,
} from "../../shared/timeline";

/**
 * Sample activity for the dashboard preview.
 *
 * Every sample goes through the same `create*Data` functions the transformers
 * use, so the preview cannot drift from what a real timeline renders; a test
 * parses each one with its renderer schema.
 */

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

const call = (
  name: string,
  detail: ToolCallItem["detail"],
  extra?: Partial<ToolCallItem>,
): ToolCallItem =>
  ({
    type: "tool_call",
    callId: `preview-${name}-${detail.type}`,
    name,
    detail,
    metadata: {},
    status: "completed",
    error: null,
    ...extra,
  }) as ToolCallItem;

const SHELL_OUTPUT = [
  "> lint",
  "src/routes/billing.ts",
  "  12:10  error  'verifyToken' is defined but never used  no-unused-vars",
  "",
  "✖ 1 problem (1 error, 0 warnings)",
].join("\n");

export const SAMPLE_SHELL = createToolCallData(
  call("Bash", {
    type: "shell",
    command: "npm run lint -- --fix",
    cwd: "/Users/dev/app",
    output: SHELL_OUTPUT,
    exitCode: 1,
  }),
);

export const SAMPLE_EDIT = createToolCallData(
  call("Edit", {
    type: "edit",
    filePath: "/Users/dev/app/src/middleware/requireAuth.ts",
    oldString: "  if (!ok) return deny(401);",
    newString: "  if (!ok) return deny(403);",
    unifiedDiff: [
      "@@ -12,4 +12,4 @@ export function requireAuth(req, next) {",
      "   const ok = verifyToken(req);",
      "-  if (!ok) return deny(401);",
      "+  if (!ok) return deny(403);",
      "   next();",
    ].join("\n"),
  }),
);

export const SAMPLE_SEARCH = createToolCallData(
  call("Grep", {
    type: "search",
    query: "verifyToken",
    numMatches: 11,
    numFiles: 7,
    filePaths: ["src/routes/billing.ts", "src/routes/users.ts"],
    durationMs: 420,
  }),
);

export const SAMPLE_READ = createToolCallData(
  call("Read", {
    type: "read",
    filePath: "/Users/dev/app/src/routes/health.ts",
    content: [
      "export function health() {",
      "  return { ok: true, version: process.env.VERSION ?? 'dev' };",
      "}",
    ].join("\n"),
  }),
);

export const SAMPLE_TOOLS: ToolCallItemData[] = [
  SAMPLE_SHELL,
  SAMPLE_EDIT,
  SAMPLE_SEARCH,
  SAMPLE_READ,
];

export const SAMPLE_REASONING: ReasoningItemData = createReasoningData(
  {
    type: "reasoning",
    text: "Auth now lives in one middleware. `requireAuth` runs once per request, so the inline checks in each route can go.",
  },
  "complete",
);

export const SAMPLE_TODO: TodoItemData | null = createTodoData({
  type: "todo",
  items: [
    { text: "Find every verifyToken() call", completed: true, status: "completed", id: "1" },
    { text: "Move auth into requireAuth", completed: true, status: "completed", id: "2" },
    {
      text: "Run the auth tests",
      completed: false,
      status: "in_progress",
      activeForm: "Running the auth tests",
      id: "3",
    },
  ],
});

/** The reply the preview shows below the activity, with an inline chip and a code block. */
export const SAMPLE_REPLY = "Done. Auth now lives in requireAuth and all 24 tests pass.";
export const SAMPLE_REPLY_INLINE = "requireAuth";
export const SAMPLE_CODE = [
  "export function requireAuth(req, next) {",
  "  const token = verifyToken(req);",
  "  if (!token) return deny(401);",
  "  next();",
  "}",
].join("\n");
