import {
  type PluginPopoverProps,
  type PluginSidebarItemProps,
  type PluginSurfaceProps,
  useRpc,
  useSettings,
} from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Image,
  Pressable,
  type PressableProps,
  ScrollView,
  type StyleProp,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { type DisplayAs, displayPreferences } from "../shared/preferences";
import { type Account, type Balance, codexUsageRpc, usageRpc } from "../shared/usage";
import { usageLogos } from "./logos";

type Theme = PluginSurfaceProps["theme"];
function Interactive({
  theme,
  transparent = false,
  selected = false,
  style,
  ...props
}: Omit<PressableProps, "style"> & {
  theme: Theme;
  transparent?: boolean;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const [active, setActive] = useState(false);
  return (
    <Pressable
      {...props}
      onHoverIn={() => setActive(true)}
      onHoverOut={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      style={({ pressed }) => [
        style,
        {
          backgroundColor:
            active || pressed
              ? theme.colors.surface2
              : selected
                ? theme.colors.surface0
                : transparent
                  ? "transparent"
                  : theme.colors.surface1,
        },
      ]}
    />
  );
}
const currency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});
const amount = (value: number | null) => (value === null ? "Not reported" : currency.format(value));
const credits = (value: number | null) => (value === null ? "Not reported" : number.format(value));
const percent = (value: number | null) =>
  value === null
    ? "Not reported"
    : value > 0 && value < 0.01
      ? "<0.01%"
      : `${percentFormat.format(value)}%`;
const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      })
    : "Not reported";
function tone(theme: Theme, value: number | null) {
  return value !== null && value > 90
    ? theme.colors.statusDanger
    : value !== null && value >= 70
      ? theme.colors.statusWarning
      : theme.colors.foregroundMuted;
}
function useUsage(hostId: string) {
  const call = useRpc(usageRpc);
  const queryClient = useQueryClient();
  const queryKey = ["enterprise-usage", "claude", hostId];
  const query = useQuery({
    queryKey,
    queryFn: () => call({ refresh: false }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: false,
    networkMode: "always",
  });
  const refresh = useMutation({
    mutationFn: () => call({ refresh: true }),
    networkMode: "always",
    retry: false,
    onSuccess: (data) => queryClient.setQueryData(queryKey, data),
  });
  return { query, refresh, busy: query.isFetching || refresh.isPending };
}
function useCodexUsage(hostId: string) {
  const call = useRpc(codexUsageRpc);
  const queryClient = useQueryClient();
  const queryKey = ["enterprise-usage", "codex", hostId];
  const query = useQuery({
    queryKey,
    queryFn: () => call({ refresh: false }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: false,
    networkMode: "always",
  });
  const refresh = useMutation({
    mutationFn: () => call({ refresh: true }),
    networkMode: "always",
    retry: false,
    onSuccess: (data) => queryClient.setQueryData(queryKey, data),
  });
  return { query, refresh, busy: query.isFetching || refresh.isPending };
}
function Meter({
  value,
  theme,
  label,
  quiet = false,
  usedPct = value,
}: {
  value: number | null;
  theme: Theme;
  label: string;
  quiet?: boolean;
  usedPct?: number | null;
}) {
  if (value === null) return null;
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: clamped, text: percent(value) }}
      style={{
        height: quiet ? 6 : 4,
        borderRadius: 3,
        backgroundColor: theme.colors.border,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          height: "100%",
          width: `${clamped}%`,
          backgroundColor: quiet ? theme.colors.foregroundMuted : tone(theme, usedPct),
          opacity: quiet ? 0.3 : 1,
        }}
      />
    </View>
  );
}
function summary(
  account: Account,
): { label: string; value: number | null; balance: Balance | null } | null {
  const spend = account.balances.find((item) => item.id === "spend") ?? account.balances[0];
  if (spend) return { label: spend.label, value: spend.usedPct, balance: spend };
  const window = account.windows.find((item) => item.summary) ?? account.windows[0];
  return window ? { label: window.label, value: window.usedPct, balance: null } : null;
}
export function UsageSidebar(props: PluginSidebarItemProps) {
  return (
    <View style={{ flexDirection: "row" }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <ClaudeUsageSidebar {...props} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <CodexUsageSidebar {...props} />
      </View>
    </View>
  );
}
export function ClaudeUsageSidebar({ theme, host, openPopover }: PluginSidebarItemProps) {
  const { query } = useUsage(host.id);
  const accounts = query.data?.accounts ?? [];
  const open = () => openPopover(UsageDetails);
  if (!accounts.length) {
    const status = query.isPending ? "Loading…" : query.isError ? "Unavailable" : "Sign in";
    return (
      <Interactive
        theme={theme}
        transparent
        accessibilityRole="button"
        accessibilityLabel={`Claude usage: ${status}. Show details`}
        onPress={open}
        style={{
          minHeight: 32,
          paddingHorizontal: 8,
          paddingVertical: 4,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          borderRadius: 6,
        }}
      >
        <Image
          source={{ uri: usageLogos.claude }}
          style={{ width: 14, height: 14, tintColor: theme.colors.foregroundMuted }}
        />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>
          {status}
        </Text>
      </Interactive>
    );
  }
  return (
    <View style={{ gap: 4 }}>
      {accounts.map((account) => {
        const item = summary(account);
        const stale = account.stale || query.isError;
        const status = stale ? "Stale" : account.status !== "available" ? "Unavailable" : null;
        return (
          <Interactive
            key={account.id}
            theme={theme}
            transparent
            accessibilityRole="button"
            accessibilityLabel={`Claude ${account.label}: ${item ? percent(item.value) : "Usage not reported"}${status ? `, ${status}` : ""}. Show usage details`}
            onPress={open}
            style={{
              minHeight: 32,
              minWidth: 0,
              paddingHorizontal: 8,
              paddingVertical: 4,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              borderRadius: 6,
            }}
          >
            <Image
              source={{ uri: usageLogos.claude }}
              style={{ width: 14, height: 14, tintColor: theme.colors.foregroundMuted }}
            />
            {item?.value !== null && item?.value !== undefined ? (
              <View style={{ flex: 1, minWidth: 12 }}>
                <Meter value={item.value} theme={theme} label={item.label} quiet />
              </View>
            ) : null}
            <Text
              numberOfLines={1}
              style={{
                color: theme.colors.foreground,
                fontSize: 12,
                fontVariant: ["tabular-nums"],
                flexShrink: 1,
              }}
            >
              {item?.value !== null && item?.value !== undefined
                ? percent(item.value)
                : item?.balance
                  ? amount(item.balance.remaining)
                  : (status ?? "Not reported")}
            </Text>
            {status && item?.value !== null && item?.value !== undefined ? (
              <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>{status}</Text>
            ) : null}
          </Interactive>
        );
      })}
    </View>
  );
}
function UsageDetails({ theme, host, layout }: PluginPopoverProps) {
  const { query, refresh, busy } = useUsage(host.id);
  const accounts = query.data?.accounts ?? [];
  const requestError = query.isError || refresh.isError;
  return (
    <View style={{ width: layout.compact ? "100%" : 340, maxWidth: "100%", padding: 16, gap: 14 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}
        >
          Claude usage
        </Text>
        <Interactive
          theme={theme}
          accessibilityRole="button"
          accessibilityLabel="Refresh Claude usage"
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          onPress={() => refresh.mutate()}
          style={{
            minHeight: layout.compact ? 44 : 34,
            paddingHorizontal: 10,
            justifyContent: "center",
            borderRadius: 5,
          }}
        >
          <Text
            style={{
              fontSize: 12,
              color: busy ? theme.colors.foregroundMuted : theme.colors.foreground,
            }}
          >
            {busy ? "Refreshing…" : "Refresh"}
          </Text>
        </Interactive>
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={2}>
        {host.label}
      </Text>
      <ScrollView
        style={{ maxHeight: layout.compact ? 440 : 500 }}
        contentContainerStyle={{ gap: 18 }}
      >
        {requestError ? (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.colors.statusWarning, fontSize: 13, lineHeight: 19 }}
          >
            Could not refresh usage from this host. Try again when it is connected.
            {accounts.length ? " Values below are from the last response." : ""}
          </Text>
        ) : null}
        {query.isPending ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
            Loading Claude usage…
          </Text>
        ) : null}
        {!query.isPending && !requestError && !accounts.length ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>
            Sign in to Anthropic in OMP on {host.label}, then refresh to load account usage.
          </Text>
        ) : null}
        {accounts.map((account, index) => (
          <AccountDetails
            key={account.id}
            account={account}
            theme={theme}
            index={index}
            requestError={requestError}
          />
        ))}
      </ScrollView>
    </View>
  );
}
function AccountDetails({
  account,
  theme,
  index,
  requestError,
}: {
  account: Account;
  theme: Theme;
  index: number;
  requestError: boolean;
}) {
  return (
    <View
      style={{
        gap: 14,
        paddingTop: index ? 16 : 0,
        borderTopWidth: index ? 1 : 0,
        borderTopColor: theme.colors.border,
      }}
    >
      <View style={{ gap: 4 }}>
        <Text
          selectable
          style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "500" }}
        >
          {account.label}
        </Text>
        {account.plan ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {account.plan.charAt(0).toUpperCase() + account.plan.slice(1)}
          </Text>
        ) : null}
      </View>
      {account.message ? (
        <Text
          accessibilityRole="alert"
          style={{ color: theme.colors.statusWarning, fontSize: 13, lineHeight: 19 }}
        >
          {account.message}
          {account.stale ? " Showing last known usage." : ""}
        </Text>
      ) : null}
      {account.balances.map((balance) => (
        <View key={balance.id} style={{ gap: 7 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13, flexShrink: 1 }}>
              {balance.label}
            </Text>
            {balance.usedPct !== null ? (
              <Text
                style={{
                  color: tone(theme, balance.usedPct),
                  fontSize: 13,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {percent(balance.usedPct)} used
              </Text>
            ) : null}
          </View>
          <Text
            selectable
            style={{ color: theme.colors.foreground, fontSize: 14, fontVariant: ["tabular-nums"] }}
          >
            {balance.limit !== null
              ? `${amount(balance.used)} / ${amount(balance.limit)} used`
              : `${amount(balance.used)} used`}
          </Text>
          <Meter theme={theme} value={balance.usedPct} label={balance.label} />
          {balance.limit !== null ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {amount(balance.remaining)} remaining
            </Text>
          ) : null}
          {balance.id === "spend" ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              Resets: {date(balance.resetsAt)}
            </Text>
          ) : null}
        </View>
      ))}
      {account.windows.length ? (
        <View
          style={{
            gap: 14,
            borderTopWidth: account.balances.length ? 1 : 0,
            borderTopColor: theme.colors.border,
            paddingTop: account.balances.length ? 14 : 0,
          }}
        >
          {account.windows.map((window) => (
            <View key={window.id} style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 13, flexShrink: 1 }}>
                  {window.label}
                </Text>
                <Text
                  style={{
                    color: tone(theme, window.usedPct),
                    fontSize: 13,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {percent(window.usedPct)} used
                </Text>
              </View>
              <Meter theme={theme} value={window.usedPct} label={window.label} />
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                Resets: {date(window.resetsAt)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {account.status === "available" && !account.balances.length && !account.windows.length ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>
          No spend limit or usage window was reported for this account.
        </Text>
      ) : null}
      {account.updatedAt ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {account.stale || requestError ? "Last successful update" : "Updated"}:{" "}
          {date(account.updatedAt)}
        </Text>
      ) : null}
    </View>
  );
}

function codexPercent(value: number | null, displayAs: DisplayAs) {
  if (value === null) return null;
  const shown = displayAs === "used" ? value : Math.max(0, 100 - value);
  return shown > 0 && shown < 0.01 ? `<0.01%` : `${percentFormat.format(shown)}%`;
}
function CodexUsageDetails({ theme, host, layout }: PluginPopoverProps) {
  const { query, refresh, busy } = useCodexUsage(host.id);
  const settings = useSettings(displayPreferences);
  const displayAs = settings.status === "ready" ? settings.values.displayAs : "used";
  const accounts = query.data?.accounts ?? [];
  const requestError = query.isError || refresh.isError;
  return (
    <View style={{ width: layout.compact ? "100%" : 340, maxWidth: "100%", padding: 16, gap: 14 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}
        >
          Codex usage
        </Text>
        <Interactive
          theme={theme}
          accessibilityRole="button"
          accessibilityLabel="Refresh Codex usage"
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          onPress={() => refresh.mutate()}
          style={{
            minHeight: layout.compact ? 44 : 34,
            paddingHorizontal: 10,
            justifyContent: "center",
            borderRadius: 5,
          }}
        >
          <Text
            style={{
              fontSize: 12,
              color: busy ? theme.colors.foregroundMuted : theme.colors.foreground,
            }}
          >
            {busy ? "Refreshing…" : "Refresh"}
          </Text>
        </Interactive>
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={2}>
        {host.label}
      </Text>
      <View style={{ gap: 6 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>Display as</Text>
          {settings.status === "ready" ? (
            <View
              accessibilityRole="radiogroup"
              accessibilityLabel="Display usage as"
              style={{
                flexDirection: "row",
                padding: 2,
                gap: 2,
                borderRadius: 6,
                backgroundColor: theme.colors.surface1,
              }}
            >
              {(["used", "remaining"] as const).map((choice) => (
                <Interactive
                  key={choice}
                  theme={theme}
                  transparent
                  selected={displayAs === choice}
                  accessibilityRole="radio"
                  accessibilityLabel={choice === "used" ? "Used" : "Remaining"}
                  accessibilityState={{ checked: displayAs === choice, disabled: settings.saving }}
                  disabled={settings.saving}
                  onPress={() => {
                    if (displayAs !== choice)
                      void settings.save(
                        { ...settings.values, displayAs: choice },
                        settings.revision,
                      );
                  }}
                  style={{
                    paddingHorizontal: 10,
                    minHeight: layout.compact ? 40 : 28,
                    justifyContent: "center",
                    borderRadius: 4,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      color:
                        displayAs === choice
                          ? theme.colors.foreground
                          : theme.colors.foregroundMuted,
                    }}
                  >
                    {choice === "used" ? "Used" : "Remaining"}
                  </Text>
                </Interactive>
              ))}
            </View>
          ) : (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {settings.status === "loading" ? "Loading…" : "Unavailable"}
            </Text>
          )}
        </View>
        {settings.saveError ? (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.colors.statusWarning, fontSize: 12 }}
          >
            Could not save display choice. Try again.
          </Text>
        ) : null}
      </View>
      <ScrollView
        style={{ maxHeight: layout.compact ? 440 : 500 }}
        contentContainerStyle={{ gap: 18 }}
      >
        {requestError ? (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.colors.statusWarning, fontSize: 13, lineHeight: 19 }}
          >
            Could not refresh usage from this host. Try again when it is connected.
            {accounts.length ? " Values below are from the last response." : ""}
          </Text>
        ) : null}
        {query.isPending ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
            Loading Codex usage…
          </Text>
        ) : null}
        {!query.isPending && !requestError && !accounts.length ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>
            Sign in to OpenAI Codex in OMP on {host.label}, then refresh to load account usage.
          </Text>
        ) : null}
        {accounts.map((account, index) => (
          <View
            key={account.id}
            style={{
              gap: 14,
              paddingTop: index ? 16 : 0,
              borderTopWidth: index ? 1 : 0,
              borderTopColor: theme.colors.border,
            }}
          >
            <View style={{ gap: 4 }}>
              <Text
                selectable
                style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "500" }}
              >
                {account.label}
              </Text>
              {account.plan ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  {account.plan.charAt(0).toUpperCase() + account.plan.slice(1)}
                </Text>
              ) : null}
            </View>
            {account.message ? (
              <Text
                accessibilityRole="alert"
                style={{ color: theme.colors.statusWarning, fontSize: 13, lineHeight: 19 }}
              >
                {account.message}
                {account.stale ? " Showing last known usage." : ""}
              </Text>
            ) : null}
            {account.balances.map((balance) => {
              const money = balance.unit === "usd";
              const value = (number: number | null) => (money ? amount(number) : credits(number));
              const shownPct =
                balance.usedPct === null
                  ? null
                  : displayAs === "used"
                    ? balance.usedPct
                    : Math.max(0, 100 - balance.usedPct);
              const unit = balance.unit === "credits" ? " credits" : "";
              return (
                <View key={balance.id} style={{ gap: 7 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                    <Text style={{ color: theme.colors.foreground, fontSize: 13, flexShrink: 1 }}>
                      {balance.label}
                    </Text>
                    {shownPct !== null ? (
                      <Text
                        style={{
                          color: tone(theme, balance.usedPct),
                          fontSize: 13,
                          fontVariant: ["tabular-nums"],
                        }}
                      >
                        {codexPercent(balance.usedPct, displayAs)} {displayAs}
                      </Text>
                    ) : null}
                  </View>
                  <Text
                    selectable
                    style={{
                      color: theme.colors.foreground,
                      fontSize: 14,
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {balance.limit !== null
                      ? `${value(displayAs === "used" ? balance.used : balance.remaining)} / ${value(balance.limit)}${unit} ${displayAs}`
                      : `${value(balance.remaining)}${unit} remaining`}
                  </Text>
                  <Meter
                    theme={theme}
                    value={shownPct}
                    usedPct={balance.usedPct}
                    label={balance.label}
                  />
                  {balance.limit !== null ? (
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                      {value(displayAs === "used" ? balance.remaining : balance.used)}
                      {unit} {displayAs === "used" ? "remaining" : "used"}
                    </Text>
                  ) : null}
                  {balance.id === "spend" ? (
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                      Resets: {date(balance.resetsAt)}
                    </Text>
                  ) : null}
                </View>
              );
            })}
            {account.windows.length ? (
              <View
                style={{
                  gap: 14,
                  borderTopWidth: account.balances.length ? 1 : 0,
                  borderTopColor: theme.colors.border,
                  paddingTop: account.balances.length ? 14 : 0,
                }}
              >
                {account.windows.map((window) => (
                  <View key={window.id} style={{ gap: 6 }}>
                    <View
                      style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}
                    >
                      <Text style={{ color: theme.colors.foreground, fontSize: 13, flexShrink: 1 }}>
                        {window.label}
                      </Text>
                      <Text
                        style={{
                          color: tone(theme, window.usedPct),
                          fontSize: 13,
                          fontVariant: ["tabular-nums"],
                        }}
                      >
                        {codexPercent(window.usedPct, displayAs)} {displayAs}
                      </Text>
                    </View>
                    <Meter
                      theme={theme}
                      value={
                        window.usedPct === null
                          ? null
                          : displayAs === "used"
                            ? window.usedPct
                            : Math.max(0, 100 - window.usedPct)
                      }
                      usedPct={window.usedPct}
                      label={window.label}
                    />
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                      Resets: {date(window.resetsAt)}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
            {account.status === "available" &&
            !account.balances.length &&
            !account.windows.length ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>
                No spend limit or usage window was reported for this account.
              </Text>
            ) : null}
            {account.updatedAt ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                {account.stale || requestError ? "Last successful update" : "Updated"}:{" "}
                {date(account.updatedAt)}
              </Text>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
export function CodexUsageSidebar({ theme, host, openPopover }: PluginSidebarItemProps) {
  const { query } = useCodexUsage(host.id);
  const settings = useSettings(displayPreferences);
  const displayAs = settings.status === "ready" ? settings.values.displayAs : "used";
  const accounts = query.data?.accounts ?? [];
  const open = () => openPopover(CodexUsageDetails);
  if (!accounts.length) {
    const status = query.isPending ? "Loading…" : query.isError ? "Unavailable" : "Sign in";
    return (
      <Interactive
        theme={theme}
        transparent
        accessibilityRole="button"
        accessibilityLabel={`Codex usage: ${status}. Show details`}
        onPress={open}
        style={{
          minHeight: 32,
          paddingHorizontal: 8,
          paddingVertical: 4,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          borderRadius: 6,
        }}
      >
        <Image
          source={{ uri: usageLogos.codex }}
          style={{ width: 14, height: 14, tintColor: theme.colors.foregroundMuted }}
        />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>
          {status}
        </Text>
      </Interactive>
    );
  }
  return (
    <View style={{ gap: 4 }}>
      {accounts.map((account) => {
        const item = summary(account);
        const value =
          item?.value === null || item?.value === undefined
            ? null
            : displayAs === "used"
              ? item.value
              : Math.max(0, 100 - item.value);
        const status =
          account.stale || query.isError
            ? "Stale"
            : account.status !== "available"
              ? "Unavailable"
              : null;
        const money = item?.balance?.unit === "usd";
        const fallbackValue = item?.balance
          ? item.balance.limit === null || displayAs === "remaining"
            ? item.balance.remaining
            : item.balance.used
          : null;
        const fallback = item?.balance
          ? money
            ? amount(fallbackValue)
            : credits(fallbackValue)
          : (status ?? "Not reported");
        return (
          <Interactive
            key={account.id}
            theme={theme}
            transparent
            accessibilityRole="button"
            accessibilityLabel={`Codex ${account.label}: ${item ? (codexPercent(item.value, displayAs) ?? fallback) : "Usage not reported"}${status ? `, ${status}` : ""}. Show usage details`}
            onPress={open}
            style={{
              minHeight: 32,
              minWidth: 0,
              paddingHorizontal: 8,
              paddingVertical: 4,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              borderRadius: 6,
            }}
          >
            <Image
              source={{ uri: usageLogos.codex }}
              style={{ width: 14, height: 14, tintColor: theme.colors.foregroundMuted }}
            />
            {value !== null ? (
              <View style={{ flex: 1, minWidth: 12 }}>
                <Meter value={value} theme={theme} label={item?.label ?? "Codex usage"} quiet />
              </View>
            ) : null}
            <Text
              numberOfLines={1}
              style={{
                color: theme.colors.foreground,
                fontSize: 12,
                fontVariant: ["tabular-nums"],
                flexShrink: 1,
              }}
            >
              {value !== null && item ? codexPercent(item.value, displayAs) : fallback}
              {item?.balance?.id !== "spend" &&
              item?.balance?.unit === "credits" &&
              (value !== null || fallbackValue !== null) ? (
                <Text style={{ color: theme.colors.foregroundMuted }}> cr</Text>
              ) : null}
            </Text>
            {status && value !== null ? (
              <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>{status}</Text>
            ) : null}
          </Interactive>
        );
      })}
    </View>
  );
}
