import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import React, { type ReactNode } from "react";
import { Text, View, type TextStyle } from "react-native";
import { isDarkSurface, useShikiTokens, type ShikiToken } from "./highlight";
import type { ActivityStyles } from "./activity";
import {
  formatUnknownValue,
  paseoToolLeafName,
  paseoToolResult,
  type ActivityPalette,
} from "../shared/presentation";

type Theme = PluginTimelineItemProps["theme"];
type JsonRecord = Record<string, unknown>;

type PaseoProps = {
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function fieldString(
  record: JsonRecord | null,
  key: string
): string | undefined {
  return stringValue(record?.[key]);
}

function fieldNumber(
  record: JsonRecord | null,
  key: string
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function fieldBoolean(
  record: JsonRecord | null,
  key: string
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function fieldArray(record: JsonRecord | null, key: string): unknown[] {
  return Array.isArray(record?.[key]) ? (record[key] as unknown[]) : [];
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  return formatUnknownValue(value);
}

function stableItemKey(value: unknown, prefix: string): string {
  const record = asRecord(value);
  const identity =
    record?.id ?? record?.agentId ?? record?.workspaceId ?? record?.browserId;
  if (typeof identity === "string" || typeof identity === "number") {
    return `${prefix}-${identity}`;
  }
  try {
    return `${prefix}-${JSON.stringify(value)}`;
  } catch {
    return prefix;
  }
}

function statusColor(
  status: string | undefined,
  palette: ActivityPalette
): string {
  switch (status?.toLowerCase()) {
    case "running":
    case "initializing":
      return palette.statusColors.running;
    case "completed":
    case "idle":
    case "active":
    case "succeeded":
    case "healthy":
    case "success":
      return palette.statusColors.completed;
    case "failed":
    case "error":
    case "unhealthy":
      return palette.statusColors.failed;
    case "canceled":
    case "paused":
    case "stopped":
    case "closed":
      return palette.statusColors.canceled;
    default:
      return palette.categoryColors.unknown;
  }
}

function Section({
  title,
  children,
  styles,
}: {
  title: string;
  children: ReactNode;
  styles: ActivityStyles;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.detailLabel}>{title}</Text>
      {children}
    </View>
  );
}

function StatusPill({
  value,
  palette,
  styles,
}: {
  value: string;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const color = statusColor(value, palette);
  return (
    <View style={[styles.paseoStatus, { backgroundColor: `${color}2e` }]}>
      <Text style={[styles.paseoStatusText, { color }]}>{value}</Text>
    </View>
  );
}

function PaseoFieldValue({
  value,
  palette,
  styles,
  depth = 0,
}: {
  value: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
  depth?: number;
}) {
  if (depth > 2)
    return (
      <Text selectable style={styles.paseoValue}>
        {scalarText(value)}
      </Text>
    );
  const record = asRecord(value);
  if (record) {
    const entries = Object.entries(record).filter(
      ([, child]) => child !== undefined
    );
    if (entries.length === 0) return <Text style={styles.paseoValue}>—</Text>;
    return (
      <View style={styles.paseoRows}>
        {entries.map(([key, child]) => (
          <PaseoField
            key={`${key}-${stableItemKey(child, key)}`}
            label={humanizeKey(key)}
            value={child}
            palette={palette}
            styles={styles}
            depth={depth + 1}
          />
        ))}
      </View>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <Text style={styles.paseoValue}>—</Text>;
    return (
      <View style={styles.paseoRows}>
        {value.map((child) => (
          <PaseoFieldValue
            key={stableItemKey(child, "item")}
            value={child}
            palette={palette}
            styles={styles}
            depth={depth + 1}
          />
        ))}
      </View>
    );
  }
  return (
    <Text selectable style={styles.paseoValue}>
      {scalarText(value)}
    </Text>
  );
}

function PaseoField({
  label,
  value,
  palette,
  styles,
  depth = 0,
}: {
  label: string;
  value: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
  depth?: number;
}) {
  return (
    <View style={styles.paseoRow}>
      <Text style={styles.paseoKey}>{label}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <PaseoFieldValue
          value={value}
          palette={palette}
          styles={styles}
          depth={depth}
        />
      </View>
    </View>
  );
}

function PaseoFields({
  fields,
  palette,
  styles,
}: {
  fields: Array<[string, unknown]>;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const visible = fields.filter(([, value]) => value !== undefined);
  if (visible.length === 0)
    return <Text style={styles.empty}>No details returned.</Text>;
  return (
    <View style={styles.paseoRows}>
      {visible.map(([label, value]) => (
        <PaseoField
          key={`${label}-${stableItemKey(value, label)}`}
          label={label}
          value={value}
          palette={palette}
          styles={styles}
        />
      ))}
    </View>
  );
}

function PaseoHero({
  icon,
  title,
  subtitle,
  color,
  styles,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  color: string;
  styles: ActivityStyles;
}) {
  return (
    <View style={[styles.paseoHero, { backgroundColor: `${color}24` }]}>
      <View style={styles.paseoHeroRow}>
        <View style={[styles.paseoHeroIcon, { backgroundColor: `${color}38` }]}>
          <Icon name={icon} color={color} size={16} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.paseoHeroTitle}>{title}</Text>
          {subtitle ? (
            <Text numberOfLines={2} style={styles.paseoHeroSubtitle}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function PromptBlock({
  text,
  label = "Prompt",
  styles,
}: {
  text: string | undefined;
  label?: string;
  styles: ActivityStyles;
}) {
  if (!text) return null;
  return (
    <Section title={label} styles={styles}>
      <Text selectable style={styles.paseoPrompt}>
        {text}
      </Text>
    </Section>
  );
}

function TokenizedLines({
  lines,
  styles,
}: {
  lines: ShikiToken[][];
  styles: ActivityStyles;
}) {
  return (
    <View>
      {lines.map((line, lineIndex) => (
        <Text key={`line-${lineIndex}`} selectable style={styles.codeLine}>
          {line.length === 0
            ? " "
            : line.map((token, tokenIndex) => {
                const tokenStyle: TextStyle = {
                  color: token.color ?? styles.codeLine.color,
                  ...(token.fontStyle && token.fontStyle & 1
                    ? { fontStyle: "italic" }
                    : {}),
                  ...(token.fontStyle && token.fontStyle & 2
                    ? { fontWeight: "700" }
                    : {}),
                  ...(token.fontStyle && token.fontStyle & 4
                    ? { textDecorationLine: "underline" }
                    : {}),
                };
                return (
                  <Text key={`${lineIndex}-${tokenIndex}`} style={tokenStyle}>
                    {token.content}
                  </Text>
                );
              })}
        </Text>
      ))}
    </View>
  );
}

function PaseoCodeBlock({
  code,
  language,
  label,
  theme,
  styles,
}: {
  code: string;
  language: string;
  label?: string;
  theme: Theme;
  styles: ActivityStyles;
}) {
  const tokens = useShikiTokens(
    code,
    language,
    isDarkSurface(theme.colors.surface0)
  );
  return (
    <Section title={label ?? "Output"} styles={styles}>
      <ScrollView horizontal nestedScrollEnabled style={styles.codeScroll}>
        <View style={styles.codeSurface}>
          {tokens ? (
            <TokenizedLines lines={tokens} styles={styles} />
          ) : (
            <Text selectable style={styles.codeLine}>
              {code || " "}
            </Text>
          )}
        </View>
      </ScrollView>
    </Section>
  );
}

function OutputFields({
  result,
  fields,
  palette,
  styles,
}: {
  result: JsonRecord | null;
  fields: Array<[string, string]>;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const values = fields.map(
    ([key, label]) => [label, result?.[key]] as [string, unknown]
  );
  return (
    <Section title="Result" styles={styles}>
      <PaseoFields fields={values} palette={palette} styles={styles} />
    </Section>
  );
}

function ActionResult({
  result,
  palette,
  styles,
  fields = [],
}: {
  result: JsonRecord | null;
  palette: ActivityPalette;
  styles: ActivityStyles;
  fields?: Array<[string, string]>;
}) {
  const visibleFields = fields
    .map(([key, label]) => [label, result?.[key]] as [string, unknown])
    .filter(([, value]) => value !== undefined);
  const success = result?.success;
  return (
    <Section title="Result" styles={styles}>
      <View style={styles.paseoRows}>
        {typeof success === "boolean" ? (
          <StatusPill
            value={success ? "Success" : "Failed"}
            palette={palette}
            styles={styles}
          />
        ) : null}
        <PaseoFields fields={visibleFields} palette={palette} styles={styles} />
      </View>
    </Section>
  );
}

function AgentSnapshot({
  snapshot,
  palette,
  styles,
}: {
  snapshot: JsonRecord | null;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (!snapshot)
    return <Text style={styles.empty}>No agent snapshot returned.</Text>;
  const capabilities = asRecord(snapshot.capabilities);
  const modes = fieldArray(snapshot, "availableModes");
  const permissions = fieldArray(snapshot, "pendingPermissions");
  return (
    <View style={styles.paseoStack}>
      <PaseoFields
        fields={[
          ["Agent", snapshot.id],
          ["Title", snapshot.title],
          ["Provider", snapshot.provider],
          ["Model", snapshot.model],
          ["Status", snapshot.status],
          ["Working directory", snapshot.cwd],
          ["Workspace", snapshot.workspaceId],
          ["Mode", snapshot.currentModeId],
          [
            "Thinking",
            snapshot.effectiveThinkingOptionId ?? snapshot.thinkingOptionId,
          ],
          ["Attention", snapshot.attentionReason],
          ["Last error", snapshot.lastError],
        ]}
        palette={palette}
        styles={styles}
      />
      {typeof snapshot.status === "string" ? (
        <StatusPill value={snapshot.status} palette={palette} styles={styles} />
      ) : null}
      {capabilities ? (
        <Section title="Capabilities" styles={styles}>
          <View style={styles.paseoChips}>
            {Object.entries(capabilities)
              .filter(([, value]) => value === true)
              .map(([key]) => (
                <View
                  key={key}
                  style={[
                    styles.paseoChip,
                    { backgroundColor: palette.categoryBackgrounds.agent },
                  ]}
                >
                  <Text style={styles.paseoChipText}>{humanizeKey(key)}</Text>
                </View>
              ))}
          </View>
        </Section>
      ) : null}
      {modes.length > 0 ? (
        <ModeList modes={modes} palette={palette} styles={styles} />
      ) : null}
      {permissions.length > 0 ? (
        <Section
          title={`Pending permissions (${permissions.length})`}
          styles={styles}
        >
          <PermissionList
            permissions={permissions}
            palette={palette}
            styles={styles}
          />
        </Section>
      ) : null}
    </View>
  );
}

function ModeList({
  modes,
  palette,
  styles,
}: {
  modes: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (modes.length === 0) return null;
  return (
    <Section title="Available modes" styles={styles}>
      <View style={styles.paseoList}>
        {modes.map((mode) => {
          const record = asRecord(mode);
          return (
            <View
              key={stableItemKey(mode, "mode")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "label") ??
                    fieldString(record, "id") ??
                    "Mode"}
                </Text>
                {fieldString(record, "id") ? (
                  <Text
                    style={[
                      styles.paseoListItemMeta,
                      { color: palette.categoryColors.agent },
                    ]}
                  >
                    {fieldString(record, "id")}
                  </Text>
                ) : null}
              </View>
              {fieldString(record, "description") ? (
                <Text style={styles.paseoListItemMeta}>
                  {fieldString(record, "description")}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function PermissionList({
  permissions,
  palette,
  styles,
}: {
  permissions: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (permissions.length === 0) return <Text style={styles.empty}>No pending permissions.</Text>;
  return (
    <View style={styles.paseoList}>
      {permissions.map((permission) => {
        const record = asRecord(permission);
        const actions = fieldArray(record, "actions");
        return (
          <View
            key={stableItemKey(permission, "permission")}
            style={styles.paseoListItem}
          >
            <View style={styles.paseoListItemHeader}>
              <Text style={styles.paseoListItemTitle}>
                {fieldString(record, "title") ??
                  fieldString(record, "name") ??
                  "Permission request"}
              </Text>
              {fieldString(record, "kind") ? (
                <StatusPill
                  value={fieldString(record, "kind")!}
                  palette={palette}
                  styles={styles}
                />
              ) : null}
            </View>
            {fieldString(record, "description") ? (
              <Text selectable style={styles.paseoListItemMeta}>
                {fieldString(record, "description")}
              </Text>
            ) : null}
            {actions.length > 0 ? (
              <Text style={styles.paseoListItemMeta}>
                Actions:{" "}
                {actions
                  .map(
                    (action) =>
                      fieldString(asRecord(action), "label") ?? "Action"
                  )
                  .join(" · ")}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function AgentTool({
  leaf,
  input,
  result,
  theme,
  palette,
  styles,
}: Omit<PaseoProps, "toolName" | "output"> & {
  leaf: string;
  result: unknown;
}) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(result);
  switch (leaf) {
    case "create_agent":
      return (
        <View style={styles.paseoStack}>
          <PaseoHero
            icon="Bot"
            title={fieldString(inputRecord, "title") ?? "New agent"}
            subtitle={fieldString(inputRecord, "provider")}
            color={palette.categoryColors.agent}
            styles={styles}
          />
          <PromptBlock
            text={fieldString(inputRecord, "initialPrompt")}
            styles={styles}
          />
          <Section title="Configuration" styles={styles}>
            <PaseoFields
              fields={[
                ["Provider", inputRecord?.provider],
                ["Workspace", inputRecord?.workspaceId],
                ["Working directory", inputRecord?.cwd],
                ["Background", inputRecord?.background],
                ["Notify on finish", inputRecord?.notifyOnFinish],
                ["Settings", inputRecord?.settings],
                ["Labels", inputRecord?.labels],
              ]}
              palette={palette}
              styles={styles}
            />
          </Section>
          <OutputFields
            result={outputRecord}
            fields={[
              ["agentId", "Agent"],
              ["type", "Provider"],
              ["status", "Status"],
              ["cwd", "Working directory"],
              ["workspaceId", "Workspace"],
              ["currentModeId", "Mode"],
            ]}
            palette={palette}
            styles={styles}
          />
          <ModeList
            modes={fieldArray(outputRecord, "availableModes")}
            palette={palette}
            styles={styles}
          />
          {fieldString(outputRecord, "status") ? (
            <StatusPill
              value={fieldString(outputRecord, "status")!}
              palette={palette}
              styles={styles}
            />
          ) : null}
          {fieldString(outputRecord, "lastMessage") ? (
            <PromptBlock
              text={fieldString(outputRecord, "lastMessage")}
              label="Last message"
              styles={styles}
            />
          ) : null}
          {fieldString(outputRecord, "guidance") ? (
            <PromptBlock
              text={fieldString(outputRecord, "guidance")}
              label="Guidance"
              styles={styles}
            />
          ) : null}
          {outputRecord?.permission ? (
            <Section title="Permission" styles={styles}>
              <PermissionList
                permissions={[outputRecord.permission]}
                palette={palette}
                styles={styles}
              />
            </Section>
          ) : null}
        </View>
      );
    case "send_agent_prompt":
      return (
        <View style={styles.paseoStack}>
          <PaseoHero
            icon="Send"
            title={fieldString(inputRecord, "agentId") ?? "Agent"}
            subtitle={fieldString(inputRecord, "sessionMode")}
            color={palette.categoryColors.agent}
            styles={styles}
          />
          <PromptBlock
            text={fieldString(inputRecord, "prompt")}
            styles={styles}
          />
          <Section title="Delivery" styles={styles}>
            <PaseoFields
              fields={[
                ["Background", inputRecord?.background],
                ["Notify on finish", inputRecord?.notifyOnFinish],
              ]}
              palette={palette}
              styles={styles}
            />
          </Section>
          <OutputFields
            result={outputRecord}
            fields={[
              ["status", "Status"],
              ["lastMessage", "Last message"],
              ["guidance", "Guidance"],
            ]}
            palette={palette}
            styles={styles}
          />
          {fieldString(outputRecord, "status") ? (
            <StatusPill
              value={fieldString(outputRecord, "status")!}
              palette={palette}
              styles={styles}
            />
          ) : null}
          {outputRecord?.permission ? (
            <Section title="Permission" styles={styles}>
              <PermissionList
                permissions={[outputRecord.permission]}
                palette={palette}
                styles={styles}
              />
            </Section>
          ) : null}
        </View>
      );
    case "get_agent_status":
      return (
        <View style={styles.paseoStack}>
          <PaseoHero
            icon="Activity"
            title={fieldString(inputRecord, "agentId") ?? "Agent status"}
            color={palette.categoryColors.agent}
            styles={styles}
          />
          <AgentSnapshot
            snapshot={asRecord(outputRecord?.snapshot) ?? outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "list_agents":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Working directory", inputRecord?.cwd],
              ["Statuses", inputRecord?.statuses],
              ["Since (hours)", inputRecord?.sinceHours],
              ["Limit", inputRecord?.limit],
              ["Include archived", inputRecord?.includeArchived],
            ]}
            palette={palette}
            styles={styles}
          />
          <AgentList
            agents={fieldArray(outputRecord, "agents")}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "get_agent_activity":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Agent", inputRecord?.agentId],
              ["Limit", inputRecord?.limit],
              ["Mode", outputRecord?.currentModeId],
              ["Updates", outputRecord?.updateCount],
            ]}
            palette={palette}
            styles={styles}
          />
          {fieldString(outputRecord, "content") ? (
            <PaseoCodeBlock
              code={fieldString(outputRecord, "content")!}
              language="markdown"
              label="Activity"
              theme={theme}
              styles={styles}
            />
          ) : null}
        </View>
      );
    case "set_agent_mode":
      return (
        <View style={styles.paseoStack}>
          <PaseoHero
            icon="SlidersHorizontal"
            title={fieldString(inputRecord, "modeId") ?? "Set mode"}
            subtitle={fieldString(inputRecord, "agentId")}
            color={palette.categoryColors.agent}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            fields={[["newMode", "New mode"]]}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "update_agent":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Agent", inputRecord?.agentId],
              ["Name", inputRecord?.name],
              ["Labels", inputRecord?.labels],
              ["Settings", inputRecord?.settings],
            ]}
            palette={palette}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "cancel_agent":
    case "archive_agent":
    case "kill_agent":
      return (
        <View style={styles.paseoStack}>
          <PaseoHero
            icon={
              leaf === "cancel_agent"
                ? "CircleStop"
                : leaf === "kill_agent"
                ? "CircleX"
                : "Archive"
            }
            title={fieldString(inputRecord, "agentId") ?? "Agent"}
            color={palette.categoryColors.agent}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "list_pending_permissions":
      return (
        <View style={styles.paseoStack}>
          <PermissionList
            permissions={fieldArray(outputRecord, "permissions")}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "respond_to_permission":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Agent", inputRecord?.agentId],
              ["Request", inputRecord?.requestId],
              ["Response", inputRecord?.response],
            ]}
            palette={palette}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    default:
      return (
        <FallbackPaseo
          input={input}
          result={result}
          palette={palette}
          styles={styles}
        />
      );
  }
}

function AgentList({
  agents,
  palette,
  styles,
}: {
  agents: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  return (
    <Section title={`Agents (${agents.length})`} styles={styles}>
      {agents.length === 0 ? (
        <Text style={styles.empty}>No agents returned.</Text>
      ) : (
        <View style={styles.paseoList}>
          {agents.map((agent) => {
            const record = asRecord(agent);
            return (
              <View
                key={stableItemKey(agent, "agent")}
                style={styles.paseoListItem}
              >
                <View style={styles.paseoListItemHeader}>
                  <Text numberOfLines={1} style={styles.paseoListItemTitle}>
                    {fieldString(record, "title") ??
                      fieldString(record, "shortId") ??
                      fieldString(record, "id") ??
                      "Agent"}
                  </Text>
                  {fieldString(record, "status") ? (
                    <StatusPill
                      value={fieldString(record, "status")!}
                      palette={palette}
                      styles={styles}
                    />
                  ) : null}
                </View>
                <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                  {[
                    fieldString(record, "provider"),
                    fieldString(record, "model"),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
                <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                  {fieldString(record, "cwd") ?? fieldString(record, "id")}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </Section>
  );
}

function WorkspaceSummary({
  result,
  palette,
  styles,
}: {
  result: JsonRecord | null;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  return (
    <OutputFields
      result={result}
      fields={[
        ["workspaceId", "Workspace"],
        ["projectId", "Project"],
        ["cwd", "Working directory"],
        ["isolation", "Isolation"],
        ["kind", "Kind"],
        ["title", "Title"],
      ]}
      palette={palette}
      styles={styles}
    />
  );
}

function WorkspaceTool({
  leaf,
  input,
  result,
  palette,
  styles,
}: Omit<PaseoProps, "toolName" | "output" | "theme"> & {
  leaf: string;
  result: unknown;
}) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(result);
  switch (leaf) {
    case "create_workspace":
      return (
        <View style={styles.paseoStack}>
          <PaseoHero
            icon="FolderPlus"
            title={fieldString(inputRecord, "title") ?? "New workspace"}
            subtitle={fieldString(inputRecord, "isolation")}
            color={palette.categoryColors.file}
            styles={styles}
          />
          <Section title="Configuration" styles={styles}>
            <PaseoFields
              fields={[
                ["Isolation", inputRecord?.isolation],
                ["Path", inputRecord?.path],
                ["Project", inputRecord?.projectId],
                ["Mode", inputRecord?.mode],
                ["Worktree", inputRecord?.worktreeSlug],
                ["Branch", inputRecord?.branchName ?? inputRecord?.branch],
                ["Base branch", inputRecord?.baseBranch],
                ["Change request", inputRecord?.prNumber],
                ["Forge", inputRecord?.forge],
              ]}
              palette={palette}
              styles={styles}
            />
          </Section>
          <WorkspaceSummary
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "list_workspaces":
      return (
        <WorkspaceList
          workspaces={fieldArray(outputRecord, "workspaces")}
          palette={palette}
          styles={styles}
        />
      );
    case "archive_workspace":
      return (
        <View style={styles.paseoStack}>
          <PaseoHero
            icon="Archive"
            title={fieldString(inputRecord, "workspaceId") ?? "Workspace"}
            color={palette.categoryColors.file}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            fields={[
              ["workspaceId", "Workspace"],
              ["archivedAgentIds", "Archived agents"],
              ["removedDirectory", "Removed directory"],
            ]}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "rename_workspace":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Workspace", inputRecord?.workspaceId],
              ["New title", inputRecord?.title],
            ]}
            palette={palette}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            fields={[
              ["workspaceId", "Workspace"],
              ["title", "Title"],
            ]}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    default:
      return (
        <FallbackPaseo
          input={input}
          result={result}
          palette={palette}
          styles={styles}
        />
      );
  }
}

function WorkspaceList({
  workspaces,
  palette,
  styles,
}: {
  workspaces: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (workspaces.length === 0) {
    return <Text style={styles.empty}>No workspaces returned.</Text>;
  }
  return (
    <Section title={`Workspaces (${workspaces.length})`} styles={styles}>
      <View style={styles.paseoList}>
        {workspaces.map((workspace) => {
          const record = asRecord(workspace);
          return (
            <View
              key={stableItemKey(workspace, "workspace")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "title") ??
                    fieldString(record, "workspaceId") ??
                    "Workspace"}
                </Text>
                {fieldString(record, "isolation") ? (
                  <StatusPill
                    value={fieldString(record, "isolation")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                {fieldString(record, "cwd")}
              </Text>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "workspaceId")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function ScriptList({
  scripts,
  palette,
  styles,
}: {
  scripts: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (scripts.length === 0) {
    return <Text style={styles.empty}>No workspace scripts returned.</Text>;
  }
  return (
    <Section title={`Scripts (${scripts.length})`} styles={styles}>
      <View style={styles.paseoList}>
        {scripts.map((script) => {
          const record = asRecord(script);
          return (
            <View
              key={stableItemKey(script, "script")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "scriptName") ?? "Script"}
                </Text>
                {fieldString(record, "lifecycle") ? (
                  <StatusPill
                    value={fieldString(record, "lifecycle")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text style={styles.paseoListItemMeta}>
                {[
                  fieldString(record, "type"),
                  fieldString(record, "health"),
                  fieldString(record, "port"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
              <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                {fieldString(record, "proxyUrl") ??
                  fieldString(record, "localProxyUrl")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function TerminalList({
  terminals,
  palette,
  styles,
}: {
  terminals: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (terminals.length === 0) {
    return <Text style={styles.empty}>No terminals returned.</Text>;
  }
  return (
    <Section title={`Terminals (${terminals.length})`} styles={styles}>
      <View style={styles.paseoList}>
        {terminals.map((terminal) => {
          const record = asRecord(terminal);
          return (
            <View
              key={stableItemKey(terminal, "terminal")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "name") ??
                    fieldString(record, "id") ??
                    "Terminal"}
                </Text>
                <Icon
                  name="SquareTerminal"
                  color={palette.categoryColors.shell}
                  size={14}
                />
              </View>
              <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                {fieldString(record, "cwd")}
              </Text>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "id")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function TerminalTool({
  leaf,
  input,
  result,
  theme,
  palette,
  styles,
}: Omit<PaseoProps, "toolName" | "output"> & {
  leaf: string;
  result: unknown;
}) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(result);
  switch (leaf) {
    case "list_workspace_scripts":
    case "start_workspace_script":
    case "stop_workspace_script": {
      const scriptResult = asRecord(result)?.script ?? result;
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Workspace", inputRecord?.workspaceId],
              ["Script", inputRecord?.scriptName],
            ]}
            palette={palette}
            styles={styles}
          />
          {leaf === "list_workspace_scripts" ? (
            <ScriptList
              scripts={fieldArray(outputRecord, "scripts")}
              palette={palette}
              styles={styles}
            />
          ) : (
            <Section title="Script" styles={styles}>
              <ScriptList
                scripts={[scriptResult]}
                palette={palette}
                styles={styles}
              />
            </Section>
          )}
        </View>
      );
    }
    case "list_terminals":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Working directory", inputRecord?.cwd],
              ["All directories", inputRecord?.all],
            ]}
            palette={palette}
            styles={styles}
          />
          <TerminalList
            terminals={fieldArray(outputRecord, "terminals")}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "create_terminal":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Working directory", inputRecord?.cwd],
              ["Workspace", inputRecord?.workspaceId],
              ["Name", inputRecord?.name],
            ]}
            palette={palette}
            styles={styles}
          />
          <Section title="Terminal" styles={styles}>
            <TerminalList
              terminals={[result]}
              palette={palette}
              styles={styles}
            />
          </Section>
        </View>
      );
    case "capture_terminal": {
      const lines = fieldArray(outputRecord, "lines")
        .map(scalarText)
        .join("\n");
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Terminal", inputRecord?.terminalId],
              ["Start", inputRecord?.start],
              ["End", inputRecord?.end],
              ["Scrollback", inputRecord?.scrollback],
              ["Strip ANSI", inputRecord?.stripAnsi],
              ["Total lines", outputRecord?.totalLines],
            ]}
            palette={palette}
            styles={styles}
          />
          {lines ? (
            <PaseoCodeBlock
              code={lines}
              language="ansi"
              label="Captured output"
              theme={theme}
              styles={styles}
            />
          ) : (
            <Text style={styles.empty}>No terminal output returned.</Text>
          )}
        </View>
      );
    }
    case "send_terminal_keys":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Terminal", inputRecord?.terminalId],
              ["Keys", inputRecord?.keys],
              ["Literal", inputRecord?.literal],
            ]}
            palette={palette}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "kill_terminal":
      return (
        <View style={styles.paseoStack}>
          <PaseoHero
            icon="CircleX"
            title={fieldString(inputRecord, "terminalId") ?? "Terminal"}
            color={palette.categoryColors.shell}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    default:
      return (
        <FallbackPaseo
          input={input}
          result={result}
          palette={palette}
          styles={styles}
        />
      );
  }
}

function ScheduleTool({
  leaf,
  input,
  result,
  theme: _theme,
  palette,
  styles,
}: Omit<PaseoProps, "toolName" | "output"> & {
  leaf: string;
  result: unknown;
}) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(result);
  const isMutation = [
    "delete_heartbeat",
    "pause_schedule",
    "resume_schedule",
    "delete_schedule",
  ].includes(leaf);
  if (isMutation) {
    return (
      <View style={styles.paseoStack}>
        <PaseoHero
          icon={
            leaf.startsWith("delete")
              ? "Trash2"
              : leaf === "pause_schedule"
              ? "Pause"
              : "Play"
          }
          title={fieldString(inputRecord, "id") ?? "Schedule"}
          color={palette.categoryColors.plan}
          styles={styles}
        />
        <ActionResult result={outputRecord} palette={palette} styles={styles} />
      </View>
    );
  }
  if (leaf === "list_schedules")
    return (
      <ScheduleList
        schedules={fieldArray(outputRecord, "schedules")}
        palette={palette}
        styles={styles}
      />
    );
  if (leaf === "schedule_logs")
    return (
      <ScheduleRuns
        runs={fieldArray(outputRecord, "runs")}
        palette={palette}
        styles={styles}
      />
    );
  if (leaf === "inspect_schedule" || leaf === "run_schedule_once")
    return (
      <View style={styles.paseoStack}>
        <ScheduleSummary
          schedule={outputRecord}
          palette={palette}
          styles={styles}
        />
        <ScheduleRuns
          runs={fieldArray(outputRecord, "runs")}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  if (leaf === "create_schedule" || leaf === "create_heartbeat") {
    return (
      <View style={styles.paseoStack}>
        <PaseoHero
          icon={leaf === "create_heartbeat" ? "HeartPulse" : "CalendarClock"}
          title={
            fieldString(inputRecord, "name") ??
            (leaf === "create_heartbeat" ? "New heartbeat" : "New schedule")
          }
          subtitle={fieldString(inputRecord, "cron")}
          color={palette.categoryColors.plan}
          styles={styles}
        />
        <PromptBlock
          text={fieldString(inputRecord, "prompt")}
          styles={styles}
        />
        <Section title="Configuration" styles={styles}>
          <PaseoFields
            fields={[
              ["Cron", inputRecord?.cron],
              ["Timezone", inputRecord?.timezone],
              ["Provider", inputRecord?.provider],
              ["Working directory", inputRecord?.cwd],
              ["Isolation", inputRecord?.isolation],
              ["Maximum runs", inputRecord?.maxRuns],
              ["Expires in", inputRecord?.expiresIn],
            ]}
            palette={palette}
            styles={styles}
          />
        </Section>
        <ScheduleSummary
          schedule={outputRecord}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  }
  if (leaf === "update_schedule")
    return (
      <View style={styles.paseoStack}>
        <PaseoFields
          fields={[
            ["Schedule", inputRecord?.id],
            ["Name", inputRecord?.name],
            ["Prompt", inputRecord?.prompt],
            ["Cron", inputRecord?.cron],
            ["Timezone", inputRecord?.timezone],
            ["Provider", inputRecord?.provider],
            ["Model", inputRecord?.model],
            ["Mode", inputRecord?.mode],
            ["Working directory", inputRecord?.cwd],
            ["Maximum runs", inputRecord?.maxRuns],
            ["Expires in", inputRecord?.expiresIn],
            ["Clear expiry", inputRecord?.clearExpires],
          ]}
          palette={palette}
          styles={styles}
        />
        <ScheduleSummary
          schedule={outputRecord}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  return (
    <FallbackPaseo
      input={input}
      result={result}
      palette={palette}
      styles={styles}
    />
  );
}

function ScheduleSummary({
  schedule,
  palette,
  styles,
}: {
  schedule: JsonRecord | null;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (!schedule) return <Text style={styles.empty}>No schedule returned.</Text>;
  const cadence = asRecord(schedule.cadence);
  const target = asRecord(schedule.target);
  const targetConfig = asRecord(target?.config);
  return (
    <View style={styles.paseoStack}>
      <OutputFields
        result={schedule}
        fields={[
          ["id", "ID"],
          ["name", "Name"],
          ["status", "Status"],
          ["nextRunAt", "Next run"],
          ["lastRunAt", "Last run"],
          ["expiresAt", "Expires"],
          ["maxRuns", "Maximum runs"],
        ]}
        palette={palette}
        styles={styles}
      />
      <PromptBlock text={fieldString(schedule, "prompt")} styles={styles} />
      <Section title="Cadence and target" styles={styles}>
        <PaseoFields
          fields={[
            ["Cadence", cadence],
            ["Target", target?.type],
            ["Agent", target?.agentId],
            ["Provider", targetConfig?.provider],
            ["Model", targetConfig?.model],
            ["Mode", targetConfig?.modeId],
            ["Working directory", targetConfig?.cwd],
            ["Isolation", targetConfig?.isolation],
          ]}
          palette={palette}
          styles={styles}
        />
      </Section>
      {fieldString(schedule, "status") ? (
        <StatusPill
          value={fieldString(schedule, "status")!}
          palette={palette}
          styles={styles}
        />
      ) : null}
    </View>
  );
}

function ScheduleList({
  schedules,
  palette,
  styles,
}: {
  schedules: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (schedules.length === 0) {
    return <Text style={styles.empty}>No schedules returned.</Text>;
  }
  return (
    <Section title={`Schedules (${schedules.length})`} styles={styles}>
      <View style={styles.paseoList}>
        {schedules.map((schedule) => {
          const record = asRecord(schedule);
          return (
            <View
              key={stableItemKey(schedule, "schedule")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "name") ??
                    fieldString(record, "id") ??
                    "Schedule"}
                </Text>
                {fieldString(record, "status") ? (
                  <StatusPill
                    value={fieldString(record, "status")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(asRecord(record?.cadence), "expression") ??
                  fieldString(record, "nextRunAt")}
              </Text>
              <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                {fieldString(record, "prompt")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function ScheduleRuns({
  runs,
  palette,
  styles,
}: {
  runs: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (runs.length === 0) {
    return <Text style={styles.empty}>No schedule runs returned.</Text>;
  }
  return (
    <Section title={`Runs (${runs.length})`} styles={styles}>
      <View style={styles.paseoList}>
        {runs.map((run) => {
          const record = asRecord(run);
          return (
            <View key={stableItemKey(run, "run")} style={styles.paseoListItem}>
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "scheduledFor") ??
                    fieldString(record, "id") ??
                    "Run"}
                </Text>
                {fieldString(record, "status") ? (
                  <StatusPill
                    value={fieldString(record, "status")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text style={styles.paseoListItemMeta}>
                {[
                  fieldString(record, "agentId"),
                  fieldString(record, "workspaceId"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
              {fieldString(record, "output") ? (
                <Text selectable style={styles.paseoListItemMeta}>
                  {fieldString(record, "output")}
                </Text>
              ) : null}
              {fieldString(record, "error") ? (
                <Text
                  selectable
                  style={[
                    styles.paseoListItemMeta,
                    { color: palette.statusColors.failed },
                  ]}
                >
                  {fieldString(record, "error")}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function ProviderTool({
  leaf,
  input,
  result,
  palette,
  styles,
}: Omit<PaseoProps, "toolName" | "output" | "theme"> & {
  leaf: string;
  result: unknown;
}) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(result);
  if (leaf === "list_providers")
    return (
      <ProviderList
        providers={fieldArray(outputRecord, "providers")}
        palette={palette}
        styles={styles}
      />
    );
  if (leaf === "list_models")
    return (
      <View style={styles.paseoStack}>
        <PaseoHero
          icon="Cpu"
          title={
            fieldString(outputRecord, "provider") ??
            fieldString(inputRecord, "provider") ??
            "Models"
          }
          color={palette.categoryColors.agent}
          styles={styles}
        />
        <ModelList
          models={fieldArray(outputRecord, "models")}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  if (leaf === "list_profiles")
    return (
      <ProfileList
        profiles={fieldArray(outputRecord, "profiles")}
        palette={palette}
        styles={styles}
      />
    );
  if (leaf === "inspect_provider")
    return (
      <View style={styles.paseoStack}>
        <PaseoHero
          icon="ScanSearch"
          title={
            fieldString(outputRecord, "label") ??
            fieldString(outputRecord, "provider") ??
            fieldString(inputRecord, "provider") ??
            "Provider"
          }
          subtitle={fieldString(outputRecord, "description")}
          color={palette.categoryColors.agent}
          styles={styles}
        />
        <PaseoFields
          fields={[
            ["Provider", outputRecord?.provider ?? inputRecord?.provider],
            ["Status", outputRecord?.status],
            ["Enabled", outputRecord?.enabled],
            ["Selected model", outputRecord?.selectedModel],
          ]}
          palette={palette}
          styles={styles}
        />
        {fieldString(outputRecord, "status") ? (
          <StatusPill
            value={fieldString(outputRecord, "status")!}
            palette={palette}
            styles={styles}
          />
        ) : null}
        <ModeList
          modes={fieldArray(outputRecord, "modes")}
          palette={palette}
          styles={styles}
        />
        <FeatureList
          features={fieldArray(outputRecord, "features")}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  return (
    <FallbackPaseo
      input={input}
      result={result}
      palette={palette}
      styles={styles}
    />
  );
}

function ProviderList({
  providers,
  palette,
  styles,
}: {
  providers: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (providers.length === 0) {
    return <Text style={styles.empty}>No providers returned.</Text>;
  }
  return (
    <Section title={`Providers (${providers.length})`} styles={styles}>
      <View style={styles.paseoList}>
        {providers.map((provider) => {
          const record = asRecord(provider);
          return (
            <View
              key={stableItemKey(provider, "provider")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "label") ??
                    fieldString(record, "id") ??
                    "Provider"}
                </Text>
                {fieldString(record, "status") ? (
                  <StatusPill
                    value={fieldString(record, "status")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                {fieldString(record, "description")}
              </Text>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "id")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function ModelList({
  models,
  palette,
  styles,
}: {
  models: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (models.length === 0) {
    return <Text style={styles.empty}>No models returned.</Text>;
  }
  return (
    <Section title={`Models (${models.length})`} styles={styles}>
      <View style={styles.paseoList}>
        {models.map((model) => {
          const record = asRecord(model);
          return (
            <View
              key={stableItemKey(model, "model")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "label") ??
                    fieldString(record, "id") ??
                    "Model"}
                </Text>
                {fieldBoolean(record, "isDefault") ? (
                  <StatusPill
                    value="Default"
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "id")}
              </Text>
              {fieldString(record, "description") ? (
                <Text style={styles.paseoListItemMeta}>
                  {fieldString(record, "description")}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function ProfileList({
  profiles,
  palette,
  styles,
}: {
  profiles: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (profiles.length === 0) {
    return <Text style={styles.empty}>No profiles returned.</Text>;
  }
  return (
    <Section title={`Profiles (${profiles.length})`} styles={styles}>
      <View style={styles.paseoList}>
        {profiles.map((profile) => {
          const record = asRecord(profile);
          return (
            <View
              key={stableItemKey(profile, "profile")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "name") ??
                    fieldString(record, "id") ??
                    "Profile"}
                </Text>
              </View>
              <PaseoFields
                fields={[
                  ["Provider", record?.provider],
                  ["Model", record?.model],
                  ["Mode", record?.modeId],
                  ["Thinking", record?.thinkingOptionId],
                ]}
                palette={palette}
                styles={styles}
              />
              {fieldString(record, "notes") ? (
                <Text selectable style={styles.paseoListItemMeta}>
                  {fieldString(record, "notes")}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function FeatureList({
  features,
  palette,
  styles,
}: {
  features: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (features.length === 0) return null;
  return (
    <Section title={`Features (${features.length})`} styles={styles}>
      <View style={styles.paseoList}>
        {features.map((feature) => {
          const record = asRecord(feature);
          return (
            <View
              key={stableItemKey(feature, "feature")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "label") ??
                    fieldString(record, "id") ??
                    "Feature"}
                </Text>
                {record?.value !== undefined ? (
                  <StatusPill
                    value={scalarText(record.value)}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "description")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function BrowserTool({
  leaf,
  input,
  output,
  result,
  theme,
  palette,
  styles,
}: Omit<PaseoProps, "toolName"> & { leaf: string; result: unknown }) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(output);
  const resultRecord = asRecord(result);
  const browserResult =
    resultRecord?.ok === true ? asRecord(resultRecord.result) : resultRecord;
  const browserFailure =
    outputRecord?.ok === false
      ? outputRecord
      : resultRecord?.ok === false
        ? resultRecord
        : null;
  if (browserFailure) {
    const error = asRecord(browserFailure.error);
    return (
      <View style={styles.paseoStack}>
        <PaseoFields
          fields={[
            ["Browser tab", inputRecord?.browserId],
            ["Error", error?.message],
            ["Retryable", error?.retryable],
          ]}
          palette={palette}
          styles={styles}
        />
        <StatusPill value="Failed" palette={palette} styles={styles} />
      </View>
    );
  }
  switch (leaf) {
    case "browser_list_tabs":
      return (
        <BrowserTabList
          tabs={fieldArray(asRecord(browserResult), "tabs")}
          palette={palette}
          styles={styles}
        />
      );
    case "browser_new_tab":
      return (
        <View style={styles.paseoStack}>
          <PaseoHero
            icon="Globe2"
            title={
              fieldString(asRecord(browserResult), "url") ??
              fieldString(inputRecord, "url") ??
              "New browser tab"
            }
            subtitle={fieldString(asRecord(browserResult), "browserId")}
            color={palette.categoryColors.search}
            styles={styles}
          />
          <PaseoFields
            fields={[
              ["Browser tab", asRecord(browserResult)?.browserId],
              ["Workspace", asRecord(browserResult)?.workspaceId],
              ["URL", asRecord(browserResult)?.url],
            ]}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "browser_snapshot":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Browser tab", browserResult?.browserId],
              ["URL", browserResult?.url],
              ["Title", browserResult?.title],
              ["Format", browserResult?.format],
              ["Truncated", browserResult?.truncated],
              ["Statistics", browserResult?.stats],
            ]}
            palette={palette}
            styles={styles}
          />
          {fieldString(browserResult, "snapshot") ? (
            <PaseoCodeBlock
              code={fieldString(browserResult, "snapshot")!}
              language="yaml"
              label="Page snapshot"
              theme={theme}
              styles={styles}
            />
          ) : null}
        </View>
      );
    case "browser_screenshot":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Browser tab", browserResult?.browserId],
              ["MIME type", browserResult?.mimeType],
              ["Width", browserResult?.width],
              ["Height", browserResult?.height],
              ["Full page", inputRecord?.fullPage],
            ]}
            palette={palette}
            styles={styles}
          />
          <Text style={styles.mutedText}>
            Screenshot data is available to the host as an image attachment.
          </Text>
        </View>
      );
    case "browser_logs":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Browser tab", browserResult?.browserId],
              ["Maximum entries", inputRecord?.maxEntries],
            ]}
            palette={palette}
            styles={styles}
          />
          <BrowserLogs
            consoleEntries={fieldArray(browserResult, "console")}
            networkEntries={fieldArray(browserResult, "network")}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "browser_evaluate":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Browser tab", browserResult?.browserId],
              ["Element", inputRecord?.ref],
            ]}
            palette={palette}
            styles={styles}
          />
          {fieldString(inputRecord, "function") ? (
            <PaseoCodeBlock
              code={fieldString(inputRecord, "function")!}
              language="javascript"
              label="Function"
              theme={theme}
              styles={styles}
            />
          ) : null}
          {fieldString(browserResult, "resultJson") ? (
            <PaseoCodeBlock
              code={fieldString(browserResult, "resultJson")!}
              language="json"
              label="Result"
              theme={theme}
              styles={styles}
            />
          ) : null}
        </View>
      );
    default:
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={browserInputFields(leaf, inputRecord)}
            palette={palette}
            styles={styles}
          />
          <PaseoFields
            fields={browserOutputFields(leaf, browserResult)}
            palette={palette}
            styles={styles}
          />
        </View>
      );
  }
}

function browserInputFields(
  leaf: string,
  input: JsonRecord | null
): Array<[string, unknown]> {
  if (!input) return [];
  const labels: Record<string, string> = {
    browserId: "Browser tab",
    ref: "Element",
    sourceRef: "Source element",
    targetRef: "Target element",
    url: "URL",
    value: "Value",
    text: "Text",
    key: "Key",
    button: "Button",
    doubleClick: "Double click",
    modifiers: "Modifiers",
    filePaths: "Files",
    fullPage: "Full page",
    maxEntries: "Maximum entries",
    timeoutMs: "Timeout",
    deltaX: "Horizontal delta",
    deltaY: "Vertical delta",
    width: "Width",
    height: "Height",
    function: "Function",
  };
  const excluded = new Set(["browserId"]);
  return Object.entries(input)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        (!excluded.has(key) || leaf === "browser_list_tabs")
    )
    .map(([key, value]) => [labels[key] ?? humanizeKey(key), value]);
}

function browserOutputFields(
  leaf: string,
  result: JsonRecord | null
): Array<[string, unknown]> {
  if (!result) return [];
  const excluded = new Set([
    "command",
    "browserId",
    "snapshot",
    "console",
    "network",
    "resultJson",
  ]);
  return Object.entries(result)
    .filter(([key, value]) => value !== undefined && !excluded.has(key))
    .map(([key, value]) => [humanizeKey(key), value]);
}

function BrowserTabList({
  tabs,
  palette,
  styles,
}: {
  tabs: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (tabs.length === 0) {
    return <Text style={styles.empty}>No browser tabs returned.</Text>;
  }
  return (
    <Section title={`Browser tabs (${tabs.length})`} styles={styles}>
      <View style={styles.paseoList}>
        {tabs.map((tab) => {
          const record = asRecord(tab);
          return (
            <View key={stableItemKey(tab, "tab")} style={styles.paseoListItem}>
              <View style={styles.paseoListItemHeader}>
                <Text numberOfLines={1} style={styles.paseoListItemTitle}>
                  {fieldString(record, "title") ?? "Untitled page"}
                </Text>
                {fieldBoolean(record, "isActive") ? (
                  <StatusPill
                    value="Active"
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                {fieldString(record, "url")}
              </Text>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "browserId")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function BrowserLogs({
  consoleEntries,
  networkEntries,
  palette,
  styles,
}: {
  consoleEntries: unknown[];
  networkEntries: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  return (
    <View style={styles.paseoStack}>
      <Section title={`Console (${consoleEntries.length})`} styles={styles}>
        <View style={styles.paseoList}>
          {consoleEntries.map((entry) => {
            const record = asRecord(entry);
            const level = fieldString(record, "level") ?? "log";
            return (
              <View
                key={stableItemKey(entry, "console")}
                style={styles.paseoListItem}
              >
                <View style={styles.paseoListItemHeader}>
                  <Text style={[styles.paseoListItemTitle, { color: statusColor(level, palette) }]}>{level}</Text>
                  <Text style={styles.paseoListItemMeta}>
                    {fieldString(record, "source")}
                  </Text>
                </View>
                <Text selectable style={styles.paseoListItemMeta}>
                  {fieldString(record, "message")}
                </Text>
              </View>
            );
          })}
        </View>
      </Section>
      <Section title={`Network (${networkEntries.length})`} styles={styles}>
        <View style={styles.paseoList}>
          {networkEntries.map((entry) => {
            const record = asRecord(entry);
            return (
              <View
                key={stableItemKey(entry, "network")}
                style={styles.paseoListItem}
              >
                <View style={styles.paseoListItemHeader}>
                  <Text numberOfLines={1} style={styles.paseoListItemTitle}>
                    {fieldString(record, "method") ?? "Request"}{" "}
                    {fieldNumber(record, "status") ?? ""}
                  </Text>
                  <Text style={styles.paseoListItemMeta}>
                    {fieldNumber(record, "duration")} ms
                  </Text>
                </View>
                <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                  {fieldString(record, "url")}
                </Text>
              </View>
            );
          })}
        </View>
      </Section>
    </View>
  );
}

function FallbackPaseo({
  input,
  result,
  palette,
  styles,
}: {
  input: unknown;
  result: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  return (
    <View style={styles.paseoStack}>
      <Section title="Input" styles={styles}>
        <PaseoFieldValue value={input} palette={palette} styles={styles} />
      </Section>
      <Section title="Result" styles={styles}>
        <PaseoFieldValue value={result} palette={palette} styles={styles} />
      </Section>
    </View>
  );
}

function PaseoFailure({
  result,
  palette,
  styles,
}: {
  result: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const failure = asRecord(result);
  const error = asRecord(failure?.error);
  return (
    <View style={styles.paseoStack}>
      <StatusPill value="Failed" palette={palette} styles={styles} />
      <PaseoFields
        fields={[
          ["Code", error?.code],
          ["Error", error?.message ?? failure?.error],
          ["Retryable", error?.retryable],
        ]}
        palette={palette}
        styles={styles}
      />
    </View>
  );
}

function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean);
  const sentence = words.join(" ").toLowerCase();
  return `${sentence[0]?.toUpperCase() ?? ""}${sentence.slice(1)}`;
}

export function PaseoToolDetail({
  toolName,
  input,
  output,
  theme,
  palette,
  styles,
}: PaseoProps) {
  const leaf = paseoToolLeafName(toolName);
  if (!leaf) return null;
  const result = paseoToolResult(output);
  if (asRecord(result)?.ok === false) {
    return <PaseoFailure result={result} palette={palette} styles={styles} />;
  }
  if (leaf.startsWith("browser_")) {
    return (
      <BrowserTool
        leaf={leaf}
        input={input}
        output={output}
        result={result}
        theme={theme}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf.includes("agent") || leaf.includes("permission")) {
    return (
      <AgentTool
        leaf={leaf}
        input={input}
        result={result}
        theme={theme}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf.includes("workspace") && !leaf.includes("script")) {
    return (
      <WorkspaceTool
        leaf={leaf}
        input={input}
        result={result}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf.includes("terminal") || leaf.includes("workspace_script")) {
    return (
      <TerminalTool
        leaf={leaf}
        input={input}
        result={result}
        theme={theme}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf.includes("schedule") || leaf.includes("heartbeat")) {
    return (
      <ScheduleTool
        leaf={leaf}
        input={input}
        result={result}
        theme={theme}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf.includes("provider") || leaf.includes("profile") || leaf === "list_models") {
    return (
      <ProviderTool
        leaf={leaf}
        input={input}
        result={result}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf === "speak") {
    const inputRecord = asRecord(input);
    return (
      <View style={styles.paseoStack}>
        <PaseoHero
          icon="MicVocal"
          title="Speak"
          color={palette.categoryColors.communication}
          styles={styles}
        />
        <PromptBlock
          text={fieldString(inputRecord, "text")}
          label="Message"
          styles={styles}
        />
        <ActionResult
          result={asRecord(result)}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  }
  return (
    <FallbackPaseo
      input={input}
      result={result}
      palette={palette}
      styles={styles}
    />
  );
}
