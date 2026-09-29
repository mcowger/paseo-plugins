import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { selectionBatchSchema } from "./settings.js";

export const severitySchema = z.enum(["critical", "high", "medium", "low", "unspecified"]);
export type Severity = z.output<typeof severitySchema>;

export const ocrSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type OcrSeverity = z.output<typeof ocrSeveritySchema>;

export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "unspecified"];

export const findingSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  content: z.string().min(1),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  existingCode: z.string().optional(),
  suggestionCode: z.string().optional(),
  category: z.string().optional(),
  severity: severitySchema,
});

export type Finding = z.output<typeof findingSchema>;

export const reviewModeSchema = z.enum(["uncommitted", "branch"]);
export type ReviewMode = z.output<typeof reviewModeSchema>;

export const reviewStatusSchema = z.enum([
  "running",
  "canceled",
  "error",
  "skipped",
  "complete",
  "partial",
  "unknown",
]);
export type ReviewStatus = z.output<typeof reviewStatusSchema>;

export const reviewCountsSchema = z.object({
  selected: z.number().int().nonnegative().optional(),
  completed: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(),
  reused: z.number().int().nonnegative().optional(),
  waived: z.number().int().nonnegative().optional(),
  filesReviewed: z.number().int().nonnegative().optional(),
});

export type ReviewCounts = z.output<typeof reviewCountsSchema>;

export const reviewResultSchema = z.object({
  jobId: z.string().min(1),
  workspaceId: z.string().min(1),
  status: reviewStatusSchema,
  mode: reviewModeSchema,
  baseRef: z.string().optional(),
  targetRef: z.string().optional(),
  sessionId: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  findings: z.array(findingSchema),
  warnings: z.array(z.string()),
  counts: reviewCountsSchema,
  message: z.string().optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
});

export type ReviewResult = z.output<typeof reviewResultSchema>;

export const branchInfoSchema = z.object({
  name: z.string().min(1),
  isRemote: z.boolean(),
  isCurrent: z.boolean(),
});

export type BranchInfo = z.output<typeof branchInfoSchema>;

export const sessionSummarySchema = z.object({
  sessionId: z.string().min(1),
  reviewMode: z.string(),
  createdAt: z.string().optional(),
  totalComments: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  gitBranch: z.string().optional(),
  diffFrom: z.string().optional(),
  diffTo: z.string().optional(),
  diffCommit: z.string().optional(),
});

export type SessionSummary = z.output<typeof sessionSummarySchema>;

const workspaceInput = z.object({ workspaceId: z.string().min(1) });

export const capabilitiesRpc = defineRpc({
  name: "ocr.capabilities",
  input: workspaceInput,
  output: z.object({
    gitAvailable: z.boolean(),
    isGitRepo: z.boolean(),
    gitRoot: z.string().nullable(),
    ocrAvailable: z.boolean(),
    ocrVersion: z.string().optional(),
    workspaceDirectory: z.string().nullable(),
  }),
});

export const listRefsRpc = defineRpc({
  name: "ocr.list-refs",
  input: workspaceInput,
  output: z.object({
    gitRoot: z.string(),
    currentBranch: z.string().nullable(),
    branches: z.array(branchInfoSchema),
    defaultTarget: z.string().nullable(),
    defaultBase: z.string().nullable(),
  }),
});

export const startReviewRpc = defineRpc({
  name: "ocr.start-review",
  input: z.object({
    workspaceId: z.string().min(1),
    mode: reviewModeSchema,
    targetRef: z.string().optional(),
    baseRef: z.string().optional(),
  }),
  output: z.object({
    jobId: z.string().min(1),
    workspaceId: z.string().min(1),
  }),
});

export const getReviewRpc = defineRpc({
  name: "ocr.get-review",
  input: z.object({
    workspaceId: z.string().min(1),
    jobId: z.string().min(1),
  }),
  output: z.object({ review: reviewResultSchema }),
});

export const cancelReviewRpc = defineRpc({
  name: "ocr.cancel-review",
  input: z.object({
    workspaceId: z.string().min(1),
    jobId: z.string().min(1),
  }),
  output: z.object({ canceled: z.boolean() }),
});

export const listHistoryRpc = defineRpc({
  name: "ocr.list-history",
  input: z.object({
    workspaceId: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  output: z.object({ sessions: z.array(sessionSummarySchema) }),
});

export const loadSessionRpc = defineRpc({
  name: "ocr.load-session",
  input: z.object({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  output: z.object({
    sessionId: z.string().min(1),
    reviewMode: z.string(),
    findings: z.array(findingSchema),
    summary: sessionSummarySchema,
  }),
});

export const prepareSelectionRpc = defineRpc({
  name: "ocr.prepare-selection",
  input: z.object({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    findingIds: z.array(z.string().min(1)).min(1).max(500),
  }),
  output: z.object({ batch: selectionBatchSchema }),
});

export const searchSelectionsRpc = defineRpc({
  name: "ocr.search-selections",
  input: z.object({ query: z.string() }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        subtitle: z.string().optional(),
        url: z.string().url(),
        text: z.string(),
        resourceType: z.string(),
      }),
    ),
  }),
});
