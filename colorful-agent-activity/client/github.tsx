import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React, { type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  type GithubJobLog,
  type GithubTreeEntry,
  type GithubWorkflowRow,
  githubOutputValue,
  githubPullRequestFacts,
  githubResultCount,
  githubRunFacts,
  githubToolKind,
  githubToolSummary,
  parseGithubCodeSearch,
  parseGithubFileResult,
  parseGithubJobLogs,
  parseGithubPullRequest,
  parseGithubRun,
  parseGithubWorkflows,
  repositoryLabel,
  shortSha,
} from "../shared/github";
import { type ActivityPalette, languageForFilePath, notInHeader } from "../shared/presentation";
import type { ActivityStyles } from "./activity";
import { PaseoCodeBlock, PaseoFields, Section, StatusPill } from "./paseo";

type Theme = PluginTimelineItemProps["theme"];
type JsonRecord = Record<string, unknown>;

type GithubToolProps = {
  toolName: string;
  input: unknown;
  output: unknown;
  theme: Theme;
  palette: ActivityPalette;
  styles: ActivityStyles;
  /** The description renderer, supplied by the container that owns it. */
  renderMarkdown?: (text: string) => ReactNode;
};

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function fieldValue(record: JsonRecord | null, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record?.[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function fieldString(record: JsonRecord | null, ...keys: string[]): string | undefined {
  const value = fieldValue(record, ...keys);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function fieldNumber(record: JsonRecord | null, ...keys: string[]): number | undefined {
  const value = fieldValue(record, ...keys);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function scalarField(record: JsonRecord | null, ...keys: string[]): string | number | undefined {
  return fieldString(record, ...keys) ?? fieldNumber(record, ...keys);
}

function fieldArray(record: JsonRecord | null, ...keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record?.[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function stableKey(value: unknown, prefix: string): string {
  const record = asRecord(value);
  const identity = fieldValue(record, "id", "node_id", "number", "name", "path", "url");
  if (typeof identity === "string" || typeof identity === "number") {
    return `${prefix}-${identity}`;
  }
  try {
    return `${prefix}-${JSON.stringify(value)}`;
  } catch {
    return prefix;
  }
}

function bytesLabel(size: number | undefined): string | undefined {
  if (size === undefined) return undefined;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function RecordFields({
  record,
  excluded = [],
  palette,
  styles,
}: {
  record: JsonRecord | null;
  excluded?: string[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (!record) return null;
  const excludedSet = new Set(excluded);
  const fields = Object.entries(record)
    .filter(([key, value]) => value !== undefined && !excludedSet.has(key))
    .slice(0, 16)
    .map(([key, value]) => [key, value] as [string, unknown]);
  return <PaseoFields fields={fields} palette={palette} styles={styles} />;
}

function GithubList({
  title,
  items,
  total,
  renderItem,
  styles,
}: {
  title: string;
  items: unknown[];
  /** The match set's size, when the response reports one larger than the page it returned. */
  total?: number;
  renderItem: (item: JsonRecord | null) => ReactNode;
  styles: ActivityStyles;
}) {
  return (
    <Section title={`${title} (${githubResultCount(items.length, total)})`} styles={styles}>
      {items.length === 0 ? (
        <Text style={styles.empty}>No results returned.</Text>
      ) : (
        <View style={styles.paseoList}>
          {items.map((item) => (
            <View key={stableKey(item, title)} style={styles.paseoListItem}>
              {renderItem(asRecord(item))}
            </View>
          ))}
        </View>
      )}
    </Section>
  );
}

// ─── search results ─────────────────────────────────────────────────────────────

function RepositoryList({
  items,
  total,
  styles,
}: {
  items: unknown[];
  total?: number;
  styles: ActivityStyles;
}) {
  return (
    <GithubList
      title="Repositories"
      items={items}
      total={total}
      styles={styles}
      renderItem={(repository) => (
        <>
          <View style={styles.paseoListItemHeader}>
            <Text selectable numberOfLines={1} style={styles.paseoListItemTitle}>
              {fieldString(repository, "full_name", "fullName", "name") ?? "Repository"}
            </Text>
            {fieldString(repository, "language") ? (
              <Text style={styles.paseoListItemMeta}>{fieldString(repository, "language")}</Text>
            ) : null}
          </View>
          {fieldString(repository, "description") ? (
            <Text selectable numberOfLines={3} style={styles.paseoListItemMeta}>
              {fieldString(repository, "description")}
            </Text>
          ) : null}
          <Text style={styles.paseoListItemMeta}>
            {[
              fieldValue(repository, "stargazers_count", "stars"),
              fieldValue(repository, "forks_count", "forks"),
              fieldString(repository, "updated_at", "updatedAt"),
            ]
              .filter((value) => value !== undefined)
              .map(String)
              .join(" · ")}
          </Text>
          {fieldString(repository, "html_url", "htmlUrl", "url") ? (
            <Text selectable numberOfLines={1} style={styles.paseoListItemMeta}>
              {fieldString(repository, "html_url", "htmlUrl", "url")}
            </Text>
          ) : null}
        </>
      )}
    />
  );
}

function CodeMatchList({
  output,
  styles,
}: {
  output: unknown;
  styles: ActivityStyles;
}) {
  const { matches, total } = parseGithubCodeSearch(output);
  return (
    <Section title={`Matches (${githubResultCount(matches.length, total)})`} styles={styles}>
      {matches.length === 0 ? (
        <Text style={styles.empty}>No matches returned.</Text>
      ) : (
        <View style={styles.paseoList}>
          {matches.map((match) => (
            <View
              key={`${match.repository ?? ""}-${match.path}-${match.fragments[0] ?? ""}`}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text selectable numberOfLines={1} style={styles.paseoListItemTitle}>
                  {match.path}
                </Text>
                {match.repository ? (
                  <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                    {match.repository}
                  </Text>
                ) : null}
              </View>
              {match.fragments.length === 0 ? null : (
                <View style={styles.codeCard}>
                  {match.fragments.map((fragment) => (
                    <Text
                      key={fragment}
                      selectable
                      numberOfLines={1}
                      style={styles.codeLine}
                    >
                      {fragment || " "}
                    </Text>
                  ))}
                </View>
              )}
            </View>
          ))}
        </View>
      )}
    </Section>
  );
}

// ─── files ──────────────────────────────────────────────────────────────────────

function DirectoryList({
  entries,
  styles,
}: {
  entries: GithubTreeEntry[];
  styles: ActivityStyles;
}) {
  return (
    <Section title={`Contents (${entries.length})`} styles={styles}>
      <View style={styles.paseoList}>
        {entries.map((entry) => (
          <View key={entry.path} style={styles.paseoListItemHeader}>
            <View style={styles.paseoListItemHeader}>
              <Icon
                name={entry.type === "dir" ? "Folder" : "File"}
                color={styles.paseoListItemMeta.color}
                size={12}
              />
              <Text selectable numberOfLines={1} style={styles.paseoListItemTitle}>
                {entry.name}
                {entry.type === "dir" ? "/" : ""}
              </Text>
            </View>
            {bytesLabel(entry.size) ? (
              <Text style={styles.paseoListItemMeta}>{bytesLabel(entry.size)}</Text>
            ) : null}
          </View>
        ))}
      </View>
    </Section>
  );
}

function FileDetail({
  input,
  output,
  theme,
  palette,
  styles,
}: {
  input: unknown;
  output: unknown;
  theme: Theme;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const inputRecord = asRecord(input);
  const view = parseGithubFileResult(output);
  const requestedPath = fieldString(inputRecord, "path") ?? "/";
  if (view?.kind === "directory") {
    return <DirectoryList entries={view.entries} styles={styles} />;
  }
  if (view?.kind === "encoded") {
    return (
      <View style={styles.paseoStack}>
        <PaseoFields
          fields={[
            ["Repository", repositoryNameOf(inputRecord)],
            ["Path", requestedPath],
            ["Size", bytesLabel(view.size)],
            ["SHA", shortSha(view.sha, 12)],
            ["URL", view.url],
          ]}
          palette={palette}
          styles={styles}
        />
        <Text style={styles.empty}>Encoded content — open it on GitHub to read.</Text>
      </View>
    );
  }
  if (!view) {
    return (
      <RecordFields
        record={asRecord(githubOutputValue(output))}
        palette={palette}
        styles={styles}
      />
    );
  }
  return (
    <View style={styles.paseoStack}>
      <PaseoCodeBlock
        code={view.text}
        language={languageForFilePath(requestedPath) ?? "text"}
        label={requestedPath}
        theme={theme}
        styles={styles}
      />
    </View>
  );
}

// ─── actions ────────────────────────────────────────────────────────────────────

function WorkflowList({
  rows,
  total,
  palette,
  styles,
}: {
  rows: GithubWorkflowRow[];
  total?: number;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  return (
    <Section title={`Workflows (${githubResultCount(rows.length, total)})`} styles={styles}>
      <View style={styles.paseoList}>
        {rows.map((row) => (
          <View key={row.path ?? row.name} style={styles.paseoListItem}>
            <View style={styles.paseoListItemHeader}>
              <Text selectable numberOfLines={1} style={styles.paseoListItemTitle}>
                {row.name}
              </Text>
              {row.state ? (
                <StatusPill value={row.state} palette={palette} styles={styles} />
              ) : null}
            </View>
            {row.path ? (
              <Text selectable numberOfLines={1} style={styles.paseoListItemMeta}>
                {row.path}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    </Section>
  );
}

function RunList({
  items,
  total,
  palette,
  styles,
}: {
  items: unknown[];
  total?: number;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  return (
    <Section title={`Workflow runs (${githubResultCount(items.length, total)})`} styles={styles}>
      <View style={styles.paseoList}>
        {items.map((item) => {
          const run = asRecord(item);
          return (
            <View key={stableKey(item, "run")} style={styles.paseoListItem}>
              <View style={styles.paseoListItemHeader}>
                <Text selectable numberOfLines={1} style={styles.paseoListItemTitle}>
                  {fieldString(run, "display_title", "displayTitle", "name") ?? "Workflow run"}
                </Text>
                {fieldString(run, "conclusion", "status") ? (
                  <StatusPill
                    value={fieldString(run, "conclusion", "status")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                {[
                  fieldNumber(run, "run_number", "runNumber") === undefined
                    ? undefined
                    : `#${fieldNumber(run, "run_number", "runNumber")}`,
                  fieldString(run, "head_branch", "headBranch", "branch"),
                  fieldString(run, "event"),
                  fieldString(asRecord(run?.actor) ?? null, "login"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function RunDetail({
  input,
  output,
  palette,
  styles,
}: {
  input: unknown;
  output: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const run = parseGithubRun(output);
  const inputRecord = asRecord(input);
  if (!run) {
    return (
      <PaseoFields
        fields={[
          ["Repository", repositoryNameOf(inputRecord)],
          ["Resource", scalarField(inputRecord, "resource_id", "workflowId", "runId")],
        ]}
        palette={palette}
        styles={styles}
      />
    );
  }
  const status = run.conclusion ?? run.status;
  return (
    <View style={styles.paseoStack}>
      <View style={styles.paseoRows}>
        {status ? (
          <View style={styles.paseoRow}>
            <Text style={styles.paseoKey}>Result</Text>
            <StatusPill value={status} palette={palette} styles={styles} />
          </View>
        ) : null}
        <PaseoFields fields={githubRunFacts(run)} palette={palette} styles={styles} />
      </View>
      {run.url ? (
        <Text selectable numberOfLines={1} style={styles.paseoListItemMeta}>
          {run.url}
        </Text>
      ) : null}
    </View>
  );
}

function JobLogBlock({
  job,
  palette,
  styles,
}: {
  job: GithubJobLog;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  return (
    <Section title={job.name} styles={styles}>
      <ScrollView nestedScrollEnabled style={styles.logScroll}>
        <View style={styles.codeSurface}>
          {job.lines.map((line, index) => (
            <Text
              // Log lines have no identity of their own; position plus content is it.
              key={`${index}-${line.slice(0, 24)}`}
              selectable
              style={[
                styles.codeLine,
                /^(?:error|fatal|✗)/i.test(line.trim())
                  ? { color: palette.statusColors.failed }
                  : null,
              ]}
            >
              {line || " "}
            </Text>
          ))}
        </View>
      </ScrollView>
    </Section>
  );
}

function JobLogsDetail({
  input,
  output,
  palette,
  styles,
}: {
  input: unknown;
  output: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const inputRecord = asRecord(input);
  const view = parseGithubJobLogs(output);
  const scope = [
    view.failedJobs === undefined
      ? undefined
      : `${view.failedJobs} failed${view.totalJobs === undefined ? "" : ` of ${view.totalJobs}`}`,
  ].filter(Boolean) as string[];
  return (
    <View style={styles.paseoStack}>
      <PaseoFields
        fields={[
          ["Repository", repositoryLabel(inputRecord?.owner && inputRecord?.repo
            ? `${String(inputRecord.owner)}/${String(inputRecord.repo)}`
            : undefined)],
          ["Jobs", scope.length > 0 ? scope[0] : undefined],
          ["Run", scalarField(inputRecord, "run_id", "runId")],
          ["Job", scalarField(inputRecord, "job_id", "jobId")],
        ]}
        palette={palette}
        styles={styles}
      />
      {view.jobs.map((job) => (
        <JobLogBlock key={job.name} job={job} palette={palette} styles={styles} />
      ))}
    </View>
  );
}

// ─── pull requests ──────────────────────────────────────────────────────────────

function PullRequestDetail({
  input,
  output,
  headerSummary,
  palette,
  styles,
  renderMarkdown,
}: Omit<GithubToolProps, "toolName" | "theme"> & {
  headerSummary: string | undefined;
}) {
  const inputRecord = asRecord(input);
  const method = fieldString(inputRecord, "method") ?? "get";
  const payload = githubOutputValue(output);
  if (Array.isArray(payload)) {
    return (
      <GithubList
        title={
          method === "get_files"
            ? "Changed files"
            : method === "get_commits"
              ? "Commits"
              : method === "get_reviews"
                ? "Reviews"
                : "Pull request results"
        }
        items={payload}
        styles={styles}
        renderItem={(item) => <RecordFields record={item} palette={palette} styles={styles} />}
      />
    );
  }
  const pr = parseGithubPullRequest(output);
  if (!pr) {
    return (
      <RecordFields record={asRecord(payload)} palette={palette} styles={styles} />
    );
  }
  return (
    <View style={styles.paseoStack}>
      <PaseoFields
        fields={[
          ["Repository", notInHeader(repositoryNameOf(inputRecord), headerSummary)],
          ...githubPullRequestFacts(pr),
        ]}
        palette={palette}
        styles={styles}
      />
      {pr.body ? (
        <Section title="Description" styles={styles}>
          {renderMarkdown ? renderMarkdown(pr.body) : <Text style={styles.empty}>{pr.body}</Text>}
        </Section>
      ) : null}
    </View>
  );
}

function repositoryNameOf(record: JsonRecord | null): string | undefined {
  const owner = fieldString(record, "owner");
  const repo = fieldString(record, "repo");
  return owner && repo ? `${owner}/${repo}` : undefined;
}

// ─── dispatch ───────────────────────────────────────────────────────────────────

export function GithubToolDetail({
  toolName,
  input,
  output,
  theme,
  palette,
  styles,
  renderMarkdown,
}: GithubToolProps) {
  const kind = githubToolKind(toolName);
  if (!kind) return null;
  const inputRecord = asRecord(input);
  const headerSummary = githubToolSummary(kind, input);
  const query = notInHeader(fieldString(inputRecord, "query"), headerSummary);
  if (kind === "search-repositories") {
    const record = asRecord(githubOutputValue(output));
    return (
      <View style={styles.paseoStack}>
        <PaseoFields fields={[["Query", query]]} palette={palette} styles={styles} />
        <RepositoryList
          items={fieldArray(record, "items", "repositories")}
          total={fieldNumber(record, "total_count", "totalCount")}
          styles={styles}
        />
      </View>
    );
  }
  if (kind === "search-code") {
    return (
      <View style={styles.paseoStack}>
        <PaseoFields fields={[["Query", query]]} palette={palette} styles={styles} />
        <CodeMatchList output={output} styles={styles} />
      </View>
    );
  }
  if (kind === "file") {
    return (
      <FileDetail input={input} output={output} theme={theme} palette={palette} styles={styles} />
    );
  }
  if (kind === "pull-request") {
    return (
      <PullRequestDetail
        input={input}
        output={output}
        headerSummary={headerSummary}
        palette={palette}
        styles={styles}
        renderMarkdown={renderMarkdown}
      />
    );
  }
  if (kind === "job-logs") {
    return <JobLogsDetail input={input} output={output} palette={palette} styles={styles} />;
  }
  if (kind === "actions-get") {
    return (
      <RunDetail input={input} output={output} palette={palette} styles={styles} />
    );
  }
  // actions-list answers with workflows or with runs, and says which by its items.
  const record = asRecord(githubOutputValue(output));
  const items = Array.isArray(record)
    ? record
    : fieldArray(record, "workflows", "workflow_runs", "workflowRuns", "runs", "jobs");
  const total = fieldNumber(record, "total_count", "totalCount");
  const looksLikeRuns = items.some((item) => {
    const run = asRecord(item);
    return fieldValue(run, "run_number", "runNumber", "head_branch", "headBranch") !== undefined;
  });
  if (looksLikeRuns) {
    return <RunList items={items} total={total} palette={palette} styles={styles} />;
  }
  const workflows = parseGithubWorkflows(output);
  if (workflows.length > 0) {
    return <WorkflowList rows={workflows} total={total} palette={palette} styles={styles} />;
  }
  return <RecordFields record={record} palette={palette} styles={styles} />;
}
