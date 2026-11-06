import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, type ListRenderItemInfo, Pressable, Text, View } from "react-native";
import { isPendingStatus } from "../shared/format";
import { plexusConfig } from "../shared/settings";
import type { ConnectionStatus, UsageRow } from "../shared/view";
import { ActivityCard } from "./card";
import { ScopeSelector } from "./scope-select";
import { type ActivityStyles, createActivityStyles } from "./styles";
import { useActivityFeed, usePlexusKeys } from "./use-activity";

/**
 * Live activity view.
 *
 * One component serves both hosts: the workspace/Explorer panel and the full-screen surface reachable
 * from the sidebar. It only needs the host props Paseo gives every plugin surface, so the panel's extra
 * `workspaceId`/`context` props are ignored. Panels remount when the dock changes views, so the selected
 * scope is remembered in module state for the session; the settings default applies until the user picks
 * something.
 */

let sessionScope: string | null = null;
let sessionChosen = false;

export interface ActivityPanelProps extends PluginSurfaceProps {
  readonly openSettings: (screenId: string) => void;
}

interface PillLabels {
  readonly label: string;
  readonly color: string;
}

function describePill(status: ConnectionStatus, paused: boolean, theme: PluginTheme): PillLabels {
  if (paused) return { label: "Paused", color: theme.colors.foregroundMuted };

  switch (status.connection) {
    case "live":
      return { label: "Live", color: theme.colors.statusSuccess };
    case "degraded":
      return { label: "Polling", color: theme.colors.statusWarning };
    case "retrying": {
      const seconds = status.retryInMs === null ? null : Math.ceil(status.retryInMs / 1000);
      return {
        label: seconds === null ? "Retrying" : `Retrying ${seconds}s`,
        color: theme.colors.statusWarning,
      };
    }
    case "connecting":
      return { label: "Connecting", color: theme.colors.statusWarning };
    case "unauthorized":
      return { label: "Key rejected", color: theme.colors.statusDanger };
    case "error":
      return { label: "Error", color: theme.colors.statusDanger };
    case "unconfigured":
      return { label: "Not configured", color: theme.colors.foregroundMuted };
    default:
      return { label: "Unknown", color: theme.colors.foregroundMuted };
  }
}

function emptyMessage(status: ConnectionStatus): string {
  switch (status.connection) {
    case "live":
      return "Requests will appear here as Plexus handles them.";
    case "degraded":
      return "The event stream is buffered; rows refresh from the usage history.";
    case "retrying":
      return "Reconnecting to the Plexus event stream.";
    case "connecting":
      return "Opening the Plexus event stream.";
    default:
      return "Waiting for Plexus.";
  }
}

interface PanelStateProps {
  readonly styles: ActivityStyles;
  readonly title: string;
  readonly body: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}

function PanelState({ styles, title, body, actionLabel, onAction }: PanelStateProps): ReactElement {
  return (
    <View style={styles.centerState}>
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateBody}>{body}</Text>
      {actionLabel !== undefined && onAction !== undefined ? (
        <Pressable
          onPress={onAction}
          style={styles.actionButton}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
        >
          <Text style={styles.actionLabel}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ActivityPanel({ theme, layout, openSettings }: ActivityPanelProps): ReactElement {
  const styles = useMemo(
    () => createActivityStyles(theme, layout.compact),
    [theme, layout.compact],
  );
  const settings = useSettings(plexusConfig);
  const defaultScope = settings.status === "ready" ? settings.values.defaultScope : null;

  const [scope, setScope] = useState<string | null>(() =>
    sessionChosen ? sessionScope : defaultScope,
  );
  const [selectorOpen, setSelectorOpen] = useState(false);

  useEffect(() => {
    if (!sessionChosen) setScope(defaultScope);
  }, [defaultScope]);

  const selectScope = useCallback((next: string | null) => {
    sessionChosen = true;
    sessionScope = next;
    setScope(next);
  }, []);

  const feed = useActivityFeed(scope);
  const keyState = usePlexusKeys();
  // A failed poll keeps whatever rows were already loaded but must never look live.
  const pill =
    feed.error === null
      ? describePill(feed.status, feed.paused, theme)
      : { label: "Error", color: theme.colors.statusDanger };

  const reloadKeys = keyState.reload;
  const openSelector = useCallback(() => {
    reloadKeys();
    setSelectorOpen(true);
  }, [reloadKeys]);

  const openPluginSettings = useCallback(() => {
    openSettings("settings");
  }, [openSettings]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<UsageRow>) => (
      <ActivityCard
        row={item}
        now={isPendingStatus(item.status) ? feed.now : null}
        styles={styles}
      />
    ),
    [feed.now, styles],
  );

  const keyExtractor = useCallback((row: UsageRow) => row.requestId, []);

  const renderBody = (): ReactElement => {
    if (feed.error !== null && feed.rows.length === 0) {
      return (
        <PanelState
          styles={styles}
          title="Activity unavailable"
          body={feed.error}
          actionLabel="Retry"
          onAction={feed.refresh}
        />
      );
    }

    if (!feed.loaded) {
      return (
        <PanelState
          styles={styles}
          title="Loading activity"
          body="Reading the Plexus connection state."
        />
      );
    }

    if (!feed.status.configured) {
      const missingKey = feed.status.connection !== "error";
      return (
        <PanelState
          styles={styles}
          title={missingKey ? "Connect Plexus" : "Check the connection"}
          body={
            missingKey
              ? "Add your Plexus admin key in the plugin settings to see live activity."
              : (feed.status.lastError ?? "The Plexus connection settings are incomplete.")
          }
          actionLabel="Open settings"
          onAction={openPluginSettings}
        />
      );
    }

    if (feed.status.connection === "unauthorized") {
      return (
        <PanelState
          styles={styles}
          title="Admin key rejected"
          body="Plexus did not accept the stored admin key. Update it in the plugin settings."
          actionLabel="Open settings"
          onAction={openPluginSettings}
        />
      );
    }

    if (feed.status.connection === "error") {
      return (
        <PanelState
          styles={styles}
          title="Connection error"
          body={feed.status.lastError ?? "Plexus could not be reached."}
          actionLabel="Open settings"
          onAction={openPluginSettings}
        />
      );
    }

    if (feed.rows.length === 0) {
      return (
        <PanelState
          styles={styles}
          title={scope === null ? "No activity yet" : `No activity for ${scope}`}
          body={emptyMessage(feed.status)}
        />
      );
    }

    return (
      <FlatList
        data={feed.rows}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.listContent}
        initialNumToRender={10}
        windowSize={7}
        extraData={feed.now}
      />
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          onPress={openSelector}
          style={styles.scopeButton}
          accessibilityRole="button"
          accessibilityLabel={`Scope: ${scope ?? "all keys"}`}
        >
          <Icon name="Filter" size={11} color={theme.colors.foregroundMuted} />
          <Text style={styles.scopeLabel} numberOfLines={1}>
            {scope ?? "All keys"}
          </Text>
          <Icon name="ChevronDown" size={11} color={theme.colors.foregroundMuted} />
        </Pressable>

        <View style={styles.pill}>
          <View style={[styles.dot, { backgroundColor: pill.color }]} />
          <Text style={styles.pillLabel}>{pill.label}</Text>
        </View>

        <Pressable
          onPress={feed.togglePause}
          style={styles.iconButton}
          accessibilityRole="button"
          accessibilityLabel={feed.paused ? "Resume live updates" : "Pause live updates"}
        >
          <Icon
            name={feed.paused ? "Play" : "Pause"}
            size={12}
            color={theme.colors.foregroundMuted}
          />
        </Pressable>
      </View>

      {renderBody()}

      <ScopeSelector
        open={selectorOpen}
        onOpenChange={setSelectorOpen}
        keys={keyState.keys}
        keysStatus={keyState.status}
        scope={scope}
        onSelect={selectScope}
        styles={styles}
        theme={theme}
      />
    </View>
  );
}
