import { Icon } from "@getpaseo/plugin/client/react-native";
import React, { type ReactNode } from "react";
import { Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import {
  PaseoCodeBlock,
  PaseoFields,
  Section,
  StatusPill,
} from "./paseo";
import {
  githubOutputText,
  githubOutputValue,
  githubToolKind,
  githubToolSummary,
  type GithubToolKind,
} from "../shared/github";
import {
  formatUnknownValue,
  languageForFilePath,
  notInHeader,
  type ActivityPalette,
} from "../shared/presentation";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";

type Theme = PluginTimelineItemProps["theme"];
type JsonRecord = Record<string, unknown>;

type GithubToolProps = {
  toolName: string;
  input: unknown;
  output: unknown;
  theme: Theme;
  palette: ActivityPalette;
  styles: ActivityStyles;
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
  const value = fieldValue(record, ...keys);
  return Array.isArray(value) ? value : [];
}

function scalarText(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return formatUnknownValue(value);
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
  renderItem,
  styles,
}: {
  title: string;
  items: unknown[];
  renderItem: (item: JsonRecord | null) => ReactNode;
  styles: ActivityStyles;
}) {
  return (
    <Section title={`${title} (${items.length})`} styles={styles}>
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

function RepositoryList({ items, styles }: { items: unknown[]; styles: ActivityStyles }) {
  return (
    <GithubList
      title="Repositories"
      items={items}
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

function CodeResultList({ items, styles }: { items: unknown[]; styles: ActivityStyles }) {
  return (
    <GithubList
      title="Code results"
      items={items}
      styles={styles}
      renderItem={(result) => {
        const repository = asRecord(fieldValue(result, "repository"));
        return (
          <>
            <View style={styles.paseoListItemHeader}>
              <Text selectable numberOfLines={1} style={styles.paseoListItemTitle}>
                {fieldString(result, "path", "name") ?? "Code result"}
              </Text>
              <Icon name="Code2" color={styles.paseoListItemTitle.color} size={12} />
            </View>
            <Text style={styles.paseoListItemMeta}>
              {fieldString(repository, "full_name", "fullName", "name") ??
                fieldString(result, "repository_url", "repositoryUrl") ??
                "Repository unavailable"}
            </Text>
            {fieldString(result, "html_url", "htmlUrl", "url") ? (
              <Text selectable numberOfLines={1} style={styles.paseoListItemMeta}>
                {fieldString(result, "html_url", "htmlUrl", "url")}
              </Text>
            ) : null}
            {fieldValue(result, "text_matches", "textMatches") !== undefined ? (
              <Text selectable numberOfLines={3} style={styles.paseoListItemMeta}>
                {scalarText(fieldValue(result, "text_matches", "textMatches"))}
              </Text>
            ) : null}
          </>
        );
      }}
    />
  );
}

function repositoryName(record: JsonRecord | null): string | undefined {
  const owner = fieldString(record, "owner");
  const repo = fieldString(record, "repo");
  return owner && repo ? `${owner}/${repo}` : undefined;
}

function PullRequestDetail({
  input,
  result,
  headerSummary,
  theme,
  palette,
  styles,
}: Omit<GithubToolProps, "toolName" | "output"> & { result: unknown; headerSummary: string | undefined }) {
  const inputRecord = asRecord(input);
  const resultRecord = asRecord(result);
  const method = fieldString(inputRecord, "method") ?? "get";
  if (Array.isArray(result)) {
    return (
      <GithubList
        title={method === "get_files" ? "Changed files" : method === "get_commits" ? "Commits" : "Pull request results"}
        items={result}
        styles={styles}
        renderItem={(item) => <RecordFields record={item} palette={palette} styles={styles} />}
      />
    );
  }
  if (typeof result === "string") {
    return <PaseoCodeBlock code={result} language={method === "get_diff" ? "diff" : "markdown"} label="Output" theme={theme} styles={styles} />;
  }
  return (
    <View style={styles.paseoStack}>
      <PaseoFields
        fields={[
          ["Repository", notInHeader(repositoryName(inputRecord), headerSummary)],
          ["Pull request", notInHeader(scalarField(inputRecord, "pullNumber", "pull_number"), headerSummary)],
          ["Method", method],
          ["Title", fieldString(resultRecord, "title")],
          ["State", fieldString(resultRecord, "state")],
          ["Author", fieldString(asRecord(resultRecord?.user), "login") ?? fieldString(resultRecord, "author")],
          ["Base", fieldString(asRecord(resultRecord?.base), "ref") ?? fieldString(resultRecord, "base")],
          ["Head", fieldString(asRecord(resultRecord?.head), "ref") ?? fieldString(resultRecord, "head")],
          ["Changed files", fieldValue(resultRecord, "changed_files", "changedFiles")],
          ["Additions", fieldValue(resultRecord, "additions")],
          ["Deletions", fieldValue(resultRecord, "deletions")],
          ["URL", fieldString(resultRecord, "html_url", "htmlUrl", "url")],
        ]}
        palette={palette}
        styles={styles}
      />
      {fieldString(resultRecord, "body") ? <PaseoCodeBlock code={fieldString(resultRecord, "body")!} language="markdown" label="Description" theme={theme} styles={styles} /> : null}
      {method === "get_reviews" || method === "get_review_comments" || method === "get_comments" ? (
        <RecordFields record={resultRecord} excluded={["body"]} palette={palette} styles={styles} />
      ) : null}
    </View>
  );
}

function ActionsDetail({
  kind,
  input,
  result,
  headerSummary,
  theme,
  palette,
  styles,
}: {
  kind: Extract<GithubToolKind, "actions-get" | "actions-list" | "actions-run" | "job-logs">;
  input: unknown;
  result: unknown;
  headerSummary: string | undefined;
  theme: Theme;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const inputRecord = asRecord(input);
  if (kind === "job-logs") {
    const logs = githubOutputText(result) ?? (typeof result === "string" ? result : undefined);
    return (
      <View style={styles.paseoStack}>
        <PaseoFields
          fields={[["Repository", repositoryName(inputRecord)], ["Job", notInHeader(scalarField(inputRecord, "jobId", "job_id"), headerSummary)], ["Resource", notInHeader(scalarField(inputRecord, "resource_id"), headerSummary)]]}
          palette={palette}
          styles={styles}
        />
        {logs ? <PaseoCodeBlock code={logs} language="ansi" label="Logs" theme={theme} styles={styles} /> : <RecordFields record={asRecord(result)} palette={palette} styles={styles} />}
      </View>
    );
  }
  if (kind === "actions-run") {
    return (
      <View style={styles.paseoStack}>
        <PaseoFields
          fields={[
            ["Repository", repositoryName(inputRecord)],
            ["Workflow", notInHeader(scalarField(inputRecord, "workflowId", "workflow_id", "workflow", "resource_id"), headerSummary)],
            ["Ref", fieldString(inputRecord, "ref")],
            ["Inputs", fieldValue(inputRecord, "inputs")],
          ]}
          palette={palette}
          styles={styles}
        />
        <RecordFields record={asRecord(result)} palette={palette} styles={styles} />
      </View>
    );
  }
  const record = asRecord(result);
  const items = Array.isArray(result)
    ? result
    : fieldArray(record, "workflows", "workflow_runs", "workflowRuns", "jobs", "artifacts", "runs");
  const title = fieldValue(record, "workflows") !== undefined
    ? "Workflows"
    : fieldValue(record, "workflow_runs", "workflowRuns", "runs") !== undefined
      ? "Workflow runs"
      : fieldValue(record, "jobs") !== undefined
        ? "Jobs"
        : fieldValue(record, "artifacts") !== undefined
          ? "Artifacts"
          : kind === "actions-get" ? "Action details" : "Action results";
  return (
    <View style={styles.paseoStack}>
      {record && !items.length ? <RecordFields record={record} palette={palette} styles={styles} /> : null}
      {items.length ? (
        <GithubList
          title={title}
          items={items}
          styles={styles}
          renderItem={(item) => (
            <>
              <View style={styles.paseoListItemHeader}>
                <Text selectable numberOfLines={1} style={styles.paseoListItemTitle}>
                  {fieldString(item, "name", "display_title", "displayTitle", "path", "id") ?? "GitHub Actions item"}
                </Text>
                {fieldString(item, "status", "conclusion", "state") ? <StatusPill value={fieldString(item, "status", "conclusion", "state")!} palette={palette} styles={styles} /> : null}
              </View>
              <Text style={styles.paseoListItemMeta}>
                {[fieldString(item, "head_branch", "headBranch", "branch"), fieldString(item, "event"), fieldString(item, "actor") ?? fieldString(asRecord(item?.actor), "login"), fieldString(item, "html_url", "htmlUrl", "url")].filter(Boolean).join(" · ")}
              </Text>
            </>
          )}
        />
      ) : null}
    </View>
  );
}

export function GithubToolDetail({
  toolName,
  input,
  output,
  theme,
  palette,
  styles,
}: GithubToolProps) {
  const kind = githubToolKind(toolName);
  if (!kind) return null;
  const result = githubOutputValue(output);
  const inputRecord = asRecord(input);
  const headerSummary = githubToolSummary(kind, input);
  if (kind === "search-repositories") {
    const record = asRecord(result);
    return (
      <View style={styles.paseoStack}>
        <PaseoFields fields={[["Query", notInHeader(fieldString(inputRecord, "query"), headerSummary)], ["Total", fieldValue(record, "total_count", "totalCount")]]} palette={palette} styles={styles} />
        <RepositoryList items={fieldArray(record, "items", "repositories")} styles={styles} />
      </View>
    );
  }
  if (kind === "search-code") {
    const record = asRecord(result);
    return (
      <View style={styles.paseoStack}>
        <PaseoFields fields={[["Query", notInHeader(fieldString(inputRecord, "query"), headerSummary)], ["Total", fieldValue(record, "total_count", "totalCount")]]} palette={palette} styles={styles} />
        <CodeResultList items={fieldArray(record, "items", "results")} styles={styles} />
      </View>
    );
  }
  if (kind === "file") {
    const record = asRecord(result);
    const path = fieldString(record, "path", "name") ?? fieldString(inputRecord, "path");
    const content = fieldString(record, "content") ?? (typeof result === "string" ? result : githubOutputText(output));
    return (
      <View style={styles.paseoStack}>
        <PaseoFields fields={[["Repository", repositoryName(inputRecord)], ["Path", notInHeader(path, headerSummary)], ["Size", fieldValue(record, "size")], ["SHA", fieldString(record, "sha")], ["Encoding", fieldString(record, "encoding")], ["URL", fieldString(record, "html_url", "htmlUrl", "download_url", "downloadUrl")]]} palette={palette} styles={styles} />
        {content ? <PaseoCodeBlock code={content} language={languageForFilePath(path) ?? "text"} label="Contents" theme={theme} styles={styles} /> : <RecordFields record={record} palette={palette} styles={styles} />}
      </View>
    );
  }
  if (kind === "pull-request") {
    return <PullRequestDetail input={input} result={result} headerSummary={headerSummary} theme={theme} palette={palette} styles={styles} />;
  }
  return <ActionsDetail kind={kind} input={input} result={result} headerSummary={headerSummary} theme={theme} palette={palette} styles={styles} />;
}
