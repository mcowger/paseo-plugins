import { describe, expect, it } from "vitest";
import {
  exaAgentFacts,
  exaToolSummary,
  parseExaAgentRun,
  parseExaFetchOutput,
} from "./exa";

function piResult(text: string) {
  return { content: text, details: { server: "exa", tool: "whatever" } };
}

describe("Exa fetch", () => {
  const fetched = [
    "# Plugin quickstart",
    "URL: https://paseo.sh/docs/plugins.md",
    "",
    "# Plugin quickstart",
    "",
    "A plugin is a TypeScript project installed into one Paseo daemon.",
    "",
    "---",
    "",
    "# API reference",
    "URL: https://paseo.sh/docs/plugins/reference.md",
    "",
    "# API reference",
    "",
    "Contribution surfaces, components, and SDK usage.",
  ].join("\n");

  it("splits a page into its reference and its body", () => {
    expect(parseExaFetchOutput(piResult(fetched))).toEqual([
      {
        title: "Plugin quickstart",
        url: "https://paseo.sh/docs/plugins.md",
        text:
          "# Plugin quickstart\n\nA plugin is a TypeScript project installed into one Paseo daemon.",
      },
      {
        title: "API reference",
        url: "https://paseo.sh/docs/plugins/reference.md",
        text: "# API reference\n\nContribution surfaces, components, and SDK usage.",
      },
    ]);
  });

  it("keeps text with no reference lines as the body", () => {
    expect(parseExaFetchOutput(piResult("just some text"))).toEqual([
      { text: "just some text" },
    ]);
  });

  it("summarizes the first URL of a fetch, which arrives as an array", () => {
    expect(exaToolSummary("fetch", { urls: ["https://a.example", "https://b.example"] })).toBe(
      "https://a.example",
    );
    expect(exaToolSummary("fetch", { url: "https://c.example" })).toBe("https://c.example");
  });
});

describe("Exa agent runs", () => {
  const payload = {
    success: true,
    id: "agent_run_a9b6a0bc204a4e3c8ca2d32ada7b7cae",
    status: "completed",
    outputReady: true,
    output: {
      text: "The Hermes JavaScript engine repository is facebook/hermes.",
      structured: { name: "facebook/hermes", stars: 11375 },
      grounding: [
        {
          field: "structured.name",
          citations: [{ url: "https://github.com/facebook/hermes", title: "facebook/hermes" }],
          confidence: "medium",
        },
        {
          field: "structured.stars",
          citations: [{ url: "https://github.com/facebook/hermes", title: "facebook/hermes" }],
          confidence: "medium",
        },
      ],
    },
    stopReason: "schema_satisfied",
    usage: { emails: 0, searches: 3, phoneNumbers: 0, agentComputeUnits: 0 },
    costDollars: { total: 0.012, emails: 0, search: 0.012, agentCompute: 0, phoneNumbers: 0 },
  };

  it("reads the answer, the structured output, and the citations", () => {
    const run = parseExaAgentRun(piResult(JSON.stringify(payload)));
    expect(run).toMatchObject({
      status: "completed",
      stopReason: "schema_satisfied",
      runId: "agent_run_a9b6a0bc204a4e3c8ca2d32ada7b7cae",
      text: "The Hermes JavaScript engine repository is facebook/hermes.",
      structured: { name: "facebook/hermes", stars: 11375 },
    });
    expect(run?.citations).toEqual([
      {
        field: "structured.name",
        confidence: "medium",
        sources: ["https://github.com/facebook/hermes"],
      },
      {
        field: "structured.stars",
        confidence: "medium",
        sources: ["https://github.com/facebook/hermes"],
      },
    ]);
  });

  it("says what the run cost and how hard it worked", () => {
    expect(exaAgentFacts(piResult(JSON.stringify(payload)))).toEqual([
      ["Searches", "3"],
      ["Cost", "$0.012"],
      ["Stopped", "schema satisfied"],
    ]);
  });

  it("reports a run that is still working the same way", () => {
    const pending = parseExaAgentRun(
      piResult(JSON.stringify({ id: "agent_run_x", status: "running", outputReady: false })),
    );
    expect(pending).toMatchObject({ status: "running", runId: "agent_run_x" });
    expect(pending?.text).toBeUndefined();
    expect(pending?.citations).toEqual([]);
  });
});
