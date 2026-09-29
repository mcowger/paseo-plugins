import { describe, expect, it } from "vitest";
import type { Finding } from "./contracts.js";
import {
  applySeverityPreset,
  buildAgentPrompt,
  buildBatchLabel,
  formatAttachmentText,
  matchesBatchQuery,
  normalizeSeverity,
  severityIconName,
  severityThemeKey,
  severityTintOpacity,
  sortFindings,
  summarizeSeverities,
} from "./presentation.js";

function makeFinding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    path: "src/a.ts",
    content: "Something looks off.",
    startLine: 1,
    endLine: 2,
    severity: "medium",
    ...overrides,
  };
}

describe("normalizeSeverity", () => {
  it("passes through known severities", () => {
    expect(normalizeSeverity("critical")).toBe("critical");
    expect(normalizeSeverity("low")).toBe("low");
  });

  it("maps unknown or missing severities to unspecified", () => {
    expect(normalizeSeverity("blocker")).toBe("unspecified");
    expect(normalizeSeverity(undefined)).toBe("unspecified");
    expect(normalizeSeverity(null)).toBe("unspecified");
  });
});

describe("sortFindings", () => {
  it("orders by severity group first", () => {
    const findings = [
      makeFinding({ id: "low", severity: "low" }),
      makeFinding({ id: "critical", severity: "critical" }),
      makeFinding({ id: "unspecified", severity: "unspecified" }),
      makeFinding({ id: "high", severity: "high" }),
      makeFinding({ id: "medium", severity: "medium" }),
    ];
    expect(sortFindings(findings).map((finding) => finding.id)).toEqual([
      "critical",
      "high",
      "medium",
      "low",
      "unspecified",
    ]);
  });

  it("sorts deterministically by path, line, and id within a group", () => {
    const findings = [
      makeFinding({ id: "b", path: "src/b.ts", startLine: 10, endLine: 10 }),
      makeFinding({ id: "a2", path: "src/a.ts", startLine: 5, endLine: 5 }),
      makeFinding({ id: "a1", path: "src/a.ts", startLine: 1, endLine: 9 }),
      makeFinding({ id: "a0", path: "src/a.ts", startLine: 1, endLine: 2 }),
    ];
    expect(sortFindings(findings).map((finding) => finding.id)).toEqual([
      "a0",
      "a1",
      "a2",
      "b",
    ]);
  });

  it("does not mutate the input array", () => {
    const findings = [makeFinding({ id: "a", severity: "low" })];
    sortFindings(findings);
    expect(findings).toHaveLength(1);
  });
});

describe("applySeverityPreset", () => {
  const findings = [
    makeFinding({ id: "c", severity: "critical" }),
    makeFinding({ id: "h", severity: "high" }),
    makeFinding({ id: "m", severity: "medium" }),
    makeFinding({ id: "l", severity: "low" }),
    makeFinding({ id: "u", severity: "unspecified" }),
  ];

  it("returns critical only for the critical preset", () => {
    expect(applySeverityPreset(findings, "critical")).toEqual(["c"]);
  });

  it("returns critical and high for high-plus", () => {
    expect(applySeverityPreset(findings, "high-plus")).toEqual(["c", "h"]);
  });

  it("returns critical, high, and medium for medium-plus", () => {
    expect(applySeverityPreset(findings, "medium-plus")).toEqual(["c", "h", "m"]);
  });

  it("returns every finding, including low and unspecified, for all", () => {
    expect(applySeverityPreset(findings, "all")).toEqual(["c", "h", "m", "l", "u"]);
  });

  it("replaces rather than merges: applying a narrower preset drops previous ids", () => {
    const narrowed = applySeverityPreset(findings, "critical");
    expect(narrowed).not.toContain("h");
    expect(narrowed).not.toContain("u");
  });
});

describe("summarizeSeverities", () => {
  it("counts in severity order", () => {
    const findings = [
      makeFinding({ id: "a", severity: "low" }),
      makeFinding({ id: "b", severity: "critical" }),
      makeFinding({ id: "c", severity: "low" }),
    ];
    expect(summarizeSeverities(findings)).toBe("1 critical, 2 low");
  });
});

describe("prompt and attachment text", () => {
  const context = {
    workspaceName: "demo",
    worktreeRoot: "/repo/demo",
    sessionId: "sess-1",
    mode: "branch",
    baseRef: "main",
    targetRef: "feature",
  };

  it("always includes the full findings after custom instructions", () => {
    const findings = [makeFinding({ id: "a", content: "UNIQUE-FINDING-TEXT" })];
    const prompt = buildAgentPrompt("Custom instructions here.", findings, context);
    expect(prompt.startsWith("Custom instructions here.")).toBe(true);
    expect(prompt).toContain("UNIQUE-FINDING-TEXT");
    expect(prompt).toContain("sess-1");
  });

  it("keeps findings even when instructions are replaced with unrelated text", () => {
    const findings = [makeFinding({ id: "a", content: "MUST-SURVIVE" })];
    const prompt = buildAgentPrompt("Do something entirely different.", findings, context);
    expect(prompt).toContain("MUST-SURVIVE");
  });

  it("formats attachment text with scope context", () => {
    const text = formatAttachmentText(
      [makeFinding({ id: "a", severity: "high", path: "src/x.ts" })],
      context,
    );
    expect(text).toContain("demo");
    expect(text).toContain("src/x.ts");
    expect(text).toContain("high");
  });

  it("labels batches with count, mode, and severity summary", () => {
    expect(buildBatchLabel([makeFinding({ id: "a" })], "uncommitted")).toContain("1 findings");
  });

  it("matches batch queries across label, workspace, session, and text", () => {
    const batch = {
      label: "2 findings",
      workspaceName: "demo",
      sessionId: "sess-9",
      attachmentText: "src/special.ts problem",
    };
    expect(matchesBatchQuery("demo special", batch)).toBe(true);
    expect(matchesBatchQuery("other-workspace", batch)).toBe(false);
    expect(matchesBatchQuery("", batch)).toBe(true);
  });
});

describe("severity theming", () => {
  it("maps each severity to a theme key, icon, and tint", () => {
    expect(severityThemeKey("critical")).toBe("statusDanger");
    expect(severityThemeKey("high")).toBe("statusWarning");
    expect(severityThemeKey("medium")).toBe("accent");
    expect(severityThemeKey("low")).toBe("foregroundMuted");
    expect(severityThemeKey("unspecified")).toBe("foregroundMuted");
    expect(severityIconName("critical")).toBe("OctagonAlert");
    expect(severityIconName("unspecified")).toBe("CircleHelp");
    expect(severityTintOpacity("critical")).toBeGreaterThan(severityTintOpacity("high"));
    expect(severityTintOpacity("high")).toBeGreaterThan(severityTintOpacity("medium"));
    expect(severityTintOpacity("low")).toBe(0);
    expect(severityTintOpacity("unspecified")).toBe(0);
  });
});
