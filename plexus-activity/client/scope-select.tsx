import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { type ReactElement, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { KeyEntry } from "../shared/view";
import type { ActivityStyles } from "./styles";

/**
 * Scope picker.
 *
 * Key names come from the plugin server (`Get /v0/management/keys`, projected to names by the
 * server). A limited admin key gets 403 there; in that case the picker falls back to typing a key
 * name, and Plexus itself keeps the stream scoped to that key.
 */

export interface ScopeSelectorProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly keys: readonly KeyEntry[];
  readonly keysStatus: "ok" | "unavailable" | "unauthorized";
  readonly scope: string | null;
  readonly onSelect: (scope: string | null) => void;
  readonly styles: ActivityStyles;
  readonly theme: PluginTheme;
}

export function ScopeSelector({
  open,
  onOpenChange,
  keys,
  keysStatus,
  scope,
  onSelect,
  styles,
  theme,
}: ScopeSelectorProps): ReactElement {
  const [typed, setTyped] = useState("");

  const choose = (next: string | null): void => {
    onSelect(next);
    onOpenChange(false);
  };

  return (
    <Modal
      title="Scope to API key"
      icon={<Icon name="Filter" size={16} color={theme.colors.foreground} />}
      open={open}
      onOpenChange={onOpenChange}
    >
      <Modal.Content scrollable={false}>
        <ScrollView>
          <Pressable
            onPress={() => choose(null)}
            style={[styles.optionRow, scope === null ? styles.optionRowSelected : null]}
            accessibilityRole="button"
            accessibilityState={{ selected: scope === null }}
          >
            <Text style={styles.optionLabel}>All keys</Text>
            {scope === null ? <Icon name="Check" size={14} color={theme.colors.accent} /> : null}
          </Pressable>

          {keys.map((key) => (
            <Pressable
              key={key.name}
              onPress={() => choose(key.name)}
              style={[styles.optionRow, scope === key.name ? styles.optionRowSelected : null]}
              accessibilityRole="button"
              accessibilityState={{ selected: scope === key.name }}
            >
              <Text style={styles.optionLabel}>{key.name}</Text>
              {key.disabled ? <Text style={styles.optionMeta}>disabled</Text> : null}
              {scope === key.name ? (
                <Icon name="Check" size={14} color={theme.colors.accent} />
              ) : null}
            </Pressable>
          ))}

          {keysStatus === "ok" ? null : (
            <View style={styles.optionRow}>
              <View style={{ flex: 1, gap: 6 }}>
                <Text style={styles.optionMeta}>
                  {keysStatus === "unauthorized"
                    ? "This key cannot list keys; Plexus already scopes the stream to it."
                    : "Key list unavailable. Type a key name to scope locally."}
                </Text>
                <TextInput
                  value={typed}
                  onChangeText={setTyped}
                  placeholder="key name"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{
                    color: theme.colors.foreground,
                    backgroundColor: theme.colors.surface0,
                    borderColor: theme.colors.border,
                    borderWidth: 1,
                    borderRadius: 6,
                    paddingHorizontal: 8,
                    paddingVertical: 6,
                    fontSize: 12,
                  }}
                />
              </View>
              <Pressable
                onPress={() => {
                  const name = typed.trim();
                  if (name !== "") choose(name);
                }}
                style={styles.actionButton}
                accessibilityRole="button"
              >
                <Text style={styles.actionLabel}>Use</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
      </Modal.Content>
    </Modal>
  );
}
