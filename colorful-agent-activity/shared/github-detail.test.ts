import { describe, expect, it } from "vitest";
import {
  cleanGithubLogLines,
  githubPullRequestFacts,
  githubRunFacts,
  parseGithubCodeSearch,
  parseGithubFileResult,
  parseGithubJobLogs,
  parseGithubPullRequest,
  parseGithubRun,
  parseGithubWorkflows,
  repositoryLabel,
} from "./github";

/** Pi hands every MCP result back as text next to its own bookkeeping. */
function piResult(text: string) {
  return { content: text, details: { server: "github", tool: "whatever" } };
}

describe("GitHub file readings", () => {
  it("reads a directory listing as entries, not JSON", () => {
    const listing = [
      { type: "dir", size: 0, name: ".agents", path: ".agents", sha: "be1faa8" },
      { type: "file", size: 759, name: "AGENTS.md", path: "AGENTS.md", sha: "cbcef05" },
    ];
    expect(parseGithubFileResult(piResult(JSON.stringify(listing)))).toEqual({
      kind: "directory",
      entries: [
        { type: "dir", name: ".agents", path: ".agents" },
        { type: "file", name: "AGENTS.md", path: "AGENTS.md", size: 759 },
      ],
    });
  });

  it("strips the download preamble and keeps the file's own text", () => {
    const text = 'successfully downloaded text file (SHA: 6f747b2f88ed6b3ebd38efad62f47695d0e0ac4c)\n{\n  "name": "x"\n}';
    expect(parseGithubFileResult(piResult(text))).toEqual({
      kind: "text",
      text: '{\n  "name": "x"\n}',
      sha: "6f747b2f88ed6b3ebd38efad62f47695d0e0ac4c",
    });
  });

  it("keeps a JSON file as text rather than reading it as metadata", () => {
    // package.json's `name` is its package, not the file's path. Reading it as an
    // envelope is what made the row show "@omercnet/paseo-plugins" as the path.
    const text = 'successfully downloaded text file (SHA: abc1234)\n{"name": "@omercnet/x", "workspaces": ["a"]}';
    const parsed = parseGithubFileResult(piResult(text));
    expect(parsed?.kind).toBe("text");
    expect(parsed?.kind === "text" ? parsed.text : "").toContain("@omercnet/x");
  });

  it("recognizes an encoded blob instead of dumping base64", () => {
    const text = JSON.stringify({
      name: "a.png",
      path: "a.png",
      sha: "deadbeef",
      size: 2048,
      encoding: "base64",
      content: "iVBORw0KGgo=",
      html_url: "https://github.com/o/r/blob/main/a.png",
    });
    expect(parseGithubFileResult(piResult(text))).toEqual({
      kind: "encoded",
      size: 2048,
      sha: "deadbeef",
      url: "https://github.com/o/r/blob/main/a.png",
    });
  });
});

describe("GitHub code search", () => {
  it("names the repository when it arrives as a string, and shows fragments as lines", () => {
    const payload = {
      incomplete_results: false,
      total_count: 2,
      items: [
        {
          path: "paseo-omp/index.client.tsx",
          repository: "omercnet/paseo-plugins",
          text_matches: [
            {
              fragment:
                '  });\n  const removeImageRenderer = client.addTimelineRenderer({\n    kind: "omp-images",',
            },
          ],
        },
      ],
    };
    expect(parseGithubCodeSearch(piResult(JSON.stringify(payload)))).toEqual({
      total: 2,
      matches: [
        {
          path: "paseo-omp/index.client.tsx",
          repository: "omercnet/paseo-plugins",
          fragments: ['}); const removeImageRenderer = client.addTimelineRenderer({ kind: "omp-images",'],
        },
      ],
    });
  });

  it("reads a repository object as well as a name", () => {
    const payload = {
      items: [{ path: "a.ts", repository: { full_name: "getpaseo/paseo" } }],
    };
    const parsed = parseGithubCodeSearch(piResult(JSON.stringify(payload)));
    expect(parsed.matches[0]?.repository).toBe("getpaseo/paseo");
    expect(parsed.matches[0]?.fragments).toEqual([]);
  });

  it("reads a repository reference in either shape", () => {
    expect(repositoryLabel("o/r")).toBe("o/r");
    expect(repositoryLabel({ full_name: "o/r" })).toBe("o/r");
    expect(repositoryLabel(undefined)).toBeUndefined();
  });
});

describe("GitHub workflows", () => {
  it("keeps the name, path, and state, and drops the URLs", () => {
    const payload = {
      total_count: 2,
      workflows: [
        {
          id: 354747894,
          name: "CI",
          path: ".github/workflows/ci.yml",
          state: "active",
          html_url: "https://github.com/o/r/blob/main/.github/workflows/ci.yml",
          badge_url: "https://example.com/badge.svg",
        },
        { avg_running_time_ms: 0, name: "top-probe", path: ".github/workflows/top-probe.yml", state: "active" },
      ],
    };
    expect(parseGithubWorkflows(piResult(JSON.stringify(payload)))).toEqual([
      { name: "CI", path: ".github/workflows/ci.yml", state: "active" },
      { name: "top-probe", path: ".github/workflows/top-probe.yml", state: "active" },
    ]);
  });
});

describe("GitHub run details", () => {
  const payload = {
    id: 39102474964,
    name: "CI",
    display_title: "fix(deps): update dependency agent-browser to v0.39.1",
    run_number: 1186,
    run_attempt: 1,
    event: "pull_request",
    status: "completed",
    conclusion: "failure",
    head_branch: "renovate/agent-browser-0.x",
    head_sha: "9e08180c5a456db0bb0cc830ea40315a3021a72a",
    head_commit: { message: "fix(deps): update dependency agent-browser to v0.39.1" },
    pull_requests: [{ number: 328 }],
    actor: {
      login: "renovate[bot]",
      id: 29139614,
      profile_url: "https://github.com/apps/renovate",
      avatar_url: "https://avatars.githubusercontent.com/in/2740?v=4",
    },
    html_url: "https://github.com/o/r/actions/runs/39102474964",
    run_started_at: "2026-10-18T06:00:08Z",
    updated_at: "2026-10-18T06:01:11Z",
  };

  it("reads the facts out of the nested payload", () => {
    const run = parseGithubRun(piResult(JSON.stringify(payload)));
    expect(run).toMatchObject({
      workflow: "CI",
      runNumber: 1186,
      event: "pull_request",
      branch: "renovate/agent-browser-0.x",
      commit: "9e08180c",
      actor: "renovate[bot]",
      conclusion: "failure",
      pullRequests: "#328",
    });
  });

  it("says them as rows instead of raw field names", () => {
    const run = parseGithubRun(piResult(JSON.stringify(payload)));
    expect(githubRunFacts(run!)).toEqual([
      ["Workflow", "CI"],
      ["Run", "#1186"],
      ["Event", "pull_request"],
      ["Branch", "renovate/agent-browser-0.x"],
      ["Commit", "9e08180c fix(deps): update dependency agent-browser to v0.39.1"],
      ["Pull request", "#328"],
      ["Actor", "renovate[bot]"],
      ["Started", "2026-10-18T06:00:08Z"],
      ["Updated", "2026-10-18T06:01:11Z"],
    ]);
  });

  it("marks a re-run attempt", () => {
    const rerun = parseGithubRun(piResult(JSON.stringify({ ...payload, run_attempt: 3 })));
    expect(githubRunFacts(rerun!).find(([label]) => label === "Run")).toEqual([
      "Run",
      "#1186 (attempt 3)",
    ]);
  });
});

describe("GitHub job logs", () => {
  const payload = {
    failed_jobs: 1,
    total_jobs: 12,
    logs: [
      {
        job_id: 117601474715,
        job_name: "paseo-shared-browser (windows-latest)",
        logs_content:
          "2026-10-18T06:00:55.4358905Z ##[group]Run oven-sh/setup-bun@0c5077e\r\n" +
          "2026-10-18T06:00:55.4359354Z with:\r\n" +
          "2026-10-18T06:00:57.5741412Z \u001b[36;1mbun install --frozen-lockfile\u001b[0m\r\n" +
          "2026-10-18T06:00:57.6515280Z ##[endgroup]\r\n" +
          "2026-10-18T06:00:58.6243911Z error: lockfile had changes, but lockfile is frozen\r\n" +
          "2026-10-18T06:00:58.7604626Z ##[error]Process completed with exit code 1.\r\n",
        message: "Job logs content retrieved successfully",
      },
    ],
    message: "Retrieved logs for 1 failed job",
  };

  it("cleans runner noise out of the log text", () => {
    expect(
      cleanGithubLogLines(
        "2026-10-18T06:00:55.4358905Z ##[group]Run thing\n" +
          "2026-10-18T06:00:56.1Z \u001b[36;1mcolored\u001b[0m\n\n\n" +
          "2026-10-18T06:00:57Z ##[error]boom\n",
      ),
    ).toEqual(["Run thing", "colored", "", "error: boom"]);
  });

  it("reads each job's log, not the envelope's fields", () => {
    expect(parseGithubJobLogs(piResult(JSON.stringify(payload)))).toEqual({
      failedJobs: 1,
      totalJobs: 12,
      jobs: [
        {
          name: "paseo-shared-browser (windows-latest)",
          lines: [
            "Run oven-sh/setup-bun@0c5077e",
            "with:",
            "bun install --frozen-lockfile",
            "",
            "error: lockfile had changes, but lockfile is frozen",
            "error: Process completed with exit code 1.",
          ],
        },
      ],
    });
  });
});

describe("GitHub pull requests", () => {
  const payload = {
    number: 328,
    title: "fix(deps): update dependency agent-browser to v0.39.1",
    body: "This PR contains the following updates:",
    state: "open",
    draft: false,
    mergeable_state: "blocked",
    html_url: "https://github.com/o/r/pull/328",
    user: { login: "renovate[bot]", id: 29139614 },
    labels: ["renovate"],
    head: { ref: "renovate/agent-browser-0.x", sha: "9e08180" },
    base: { ref: "main", sha: "5136da8" },
    additions: 1,
    deletions: 1,
    changed_files: 1,
    commits: 1,
    comments: 1,
    created_at: "2026-10-13T00:38:22Z",
    updated_at: "2026-10-18T06:00:10Z",
  };

  it("reads the summary and keeps the body for rendering", () => {
    const pr = parseGithubPullRequest(piResult(JSON.stringify(payload)));
    expect(pr).toMatchObject({
      title: "fix(deps): update dependency agent-browser to v0.39.1",
      author: "renovate[bot]",
      base: "main",
      head: "renovate/agent-browser-0.x",
      changedFiles: 1,
      labels: "renovate",
      body: "This PR contains the following updates:",
    });
  });

  it("says them as rows, with the branch and diffstat in one line each", () => {
    const pr = parseGithubPullRequest(piResult(JSON.stringify(payload)));
    expect(githubPullRequestFacts(pr!)).toEqual([
      ["Title", "fix(deps): update dependency agent-browser to v0.39.1"],
      ["State", "open"],
      ["Author", "renovate[bot]"],
      ["Branch", "renovate/agent-browser-0.x → main"],
      ["Changes", "1 file · +1 · −1"],
      ["Commits", "1"],
      ["Comments", "1"],
      ["Merge", "blocked"],
      ["Labels", "renovate"],
      ["Updated", "2026-10-18T06:00:10Z"],
      ["URL", "https://github.com/o/r/pull/328"],
    ]);
    // The body belongs to the renderer, not to the table.
    expect(githubPullRequestFacts(pr!).some(([label]) => label === "Description")).toBe(false);
  });
});
