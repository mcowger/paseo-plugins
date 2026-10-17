import type { PluginTheme } from "@getpaseo/plugin";
import { useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, type TextStyle, View, type ViewStyle } from "react-native";
import type { RepoConfig, UberProject } from "../shared/config";
import { polyrepoSettings } from "../shared/settings";

interface SettingsStyles {
  readonly container: ViewStyle;
  readonly heading: TextStyle;
  readonly label: TextStyle;
  readonly input: TextStyle;
  readonly multiline: TextStyle;
  readonly row: ViewStyle;
  readonly name: TextStyle;
  readonly meta: TextStyle;
  readonly error: TextStyle;
  readonly hint: TextStyle;
  readonly actions: ViewStyle;
  readonly button: ViewStyle;
  readonly buttonText: TextStyle;
}

function createStyles(theme: PluginTheme, compact: boolean): SettingsStyles {
  const fontSize = compact ? 12 : 13;
  const small = compact ? 10 : 11;
  const input: TextStyle = {
    color: theme.colors.foreground,
    fontSize,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
  };
  return {
    container: { gap: 10 },
    heading: { color: theme.colors.foreground, fontSize: fontSize + 3, fontWeight: "700" },
    label: { color: theme.colors.foregroundMuted, fontSize: small, fontWeight: "600" },
    input,
    multiline: { ...input, minHeight: 90, textAlignVertical: "top" },
    row: { gap: 2, paddingVertical: 6, borderTopWidth: 1, borderTopColor: theme.colors.border },
    name: { color: theme.colors.foreground, fontSize, fontWeight: "600" },
    meta: { color: theme.colors.foregroundMuted, fontSize: small },
    error: { color: theme.colors.statusDanger, fontSize: small },
    hint: { color: theme.colors.foregroundMuted, fontSize: small },
    actions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
    button: {
      paddingVertical: 7,
      paddingHorizontal: 12,
      borderRadius: 6,
      backgroundColor: theme.colors.surface2,
    },
    buttonText: { color: theme.colors.foreground, fontSize: small, fontWeight: "600" },
  };
}

function reposToText(repos: readonly RepoConfig[]): string {
  return repos
    .map((repo) => [repo.id, repo.sourcePath, repo.dirTemplate, repo.baseBranch ?? ""].join("|"))
    .join("\n");
}

function parseRepos(text: string): { repos: RepoConfig[]; error: string | null } {
  const repos: RepoConfig[] = [];
  const seen = new Set<string>();
  for (const [index, line] of text
    .split("\n")
    .map((entry) => entry.trim())
    .entries()) {
    if (line.length === 0) continue;
    const parts = line.split("|").map((part) => part.trim());
    const [id, sourcePath, dirTemplate, baseBranch] = parts;
    if (!id || !sourcePath) {
      return { repos: [], error: `line ${index + 1}: need at least id|sourcePath` };
    }
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      return { repos: [], error: `line ${index + 1}: bad repo id ${id}` };
    }
    if (seen.has(id)) return { repos: [], error: `line ${index + 1}: duplicate repo id ${id}` };
    seen.add(id);
    repos.push({
      id,
      sourcePath,
      dirTemplate: dirTemplate && dirTemplate.length > 0 ? dirTemplate : "{repo}_{branch}",
      ...(baseBranch && baseBranch.length > 0 ? { baseBranch } : {}),
    });
  }
  return { repos, error: null };
}

const EMPTY_PROJECTS: readonly UberProject[] = [];

const EMPTY_FORM = {
  id: "",
  displayName: "",
  branchTemplate: "{feature}",
  rootDirTemplate: "{uberProject}-{feature}",
  agentsTemplatePath: "",
  virtualRootBase: "",
  reposText: "",
};

export function PolyRepoSettingsScreen({
  theme,
  layout,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
}): ReactElement {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const toast = useToast();
  const settings = useSettings(polyrepoSettings);

  const [rootBase, setRootBase] = useState("");
  const [loadedRevision, setLoadedRevision] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (settings.status === "ready" && settings.revision !== loadedRevision) {
      setRootBase(settings.values.virtualRootBase ?? "");
      setLoadedRevision(settings.revision);
    }
  }, [settings, loadedRevision]);

  const projects: readonly UberProject[] = useMemo(
    () => (settings.status === "ready" ? settings.values.uberProjects : EMPTY_PROJECTS),
    [settings],
  );

  const patch = useCallback((update: Partial<typeof EMPTY_FORM>) => {
    setForm((prev) => ({ ...prev, ...update }));
  }, []);

  const setId = useCallback((value: string) => patch({ id: value }), [patch]);
  const setDisplayName = useCallback((value: string) => patch({ displayName: value }), [patch]);
  const setBranchTemplate = useCallback(
    (value: string) => patch({ branchTemplate: value }),
    [patch],
  );
  const setRootDirTemplate = useCallback(
    (value: string) => patch({ rootDirTemplate: value }),
    [patch],
  );
  const setAgentsTemplatePath = useCallback(
    (value: string) => patch({ agentsTemplatePath: value }),
    [patch],
  );
  const setProjectRootBase = useCallback(
    (value: string) => patch({ virtualRootBase: value }),
    [patch],
  );
  const setReposText = useCallback((value: string) => patch({ reposText: value }), [patch]);

  const startEdit = useCallback((project: UberProject) => {
    setEditingId(project.id);
    setForm({
      id: project.id,
      displayName: project.displayName,
      branchTemplate: project.branchTemplate,
      rootDirTemplate: project.rootDirTemplate,
      agentsTemplatePath: project.agentsTemplatePath,
      virtualRootBase: project.virtualRootBase ?? "",
      reposText: reposToText(project.repos),
    });
    setFormError(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  }, []);

  const saveAll = useCallback(
    async (nextProjects: UberProject[], nextRootBase: string) => {
      if (settings.status !== "ready") return false;
      return settings.save(
        {
          virtualRootBase: nextRootBase.trim().length > 0 ? nextRootBase.trim() : undefined,
          uberProjects: nextProjects,
        },
        settings.revision,
      );
    },
    [settings],
  );

  const handleSaveRootBase = useCallback(async () => {
    const ok = await saveAll([...projects], rootBase);
    if (ok) toast.show("Default root saved");
    else toast.error(settings.saveError ?? "Save failed; reload and retry");
  }, [saveAll, projects, rootBase, toast, settings.saveError]);

  const handleSaveProject = useCallback(async () => {
    const id = form.id.trim();
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      setFormError("id must be lowercase letters, numbers, hyphens, starting with a letter");
      return;
    }
    if (form.displayName.trim().length === 0) {
      setFormError("display name is required");
      return;
    }
    if (form.agentsTemplatePath.trim().length === 0) {
      setFormError("agents template path is required");
      return;
    }
    const parsed = parseRepos(form.reposText);
    if (parsed.error || parsed.repos.length === 0) {
      setFormError(parsed.error ?? "at least one repo is required");
      return;
    }
    const project: UberProject = {
      id,
      displayName: form.displayName.trim(),
      branchTemplate: form.branchTemplate.trim() || "{feature}",
      rootDirTemplate: form.rootDirTemplate.trim() || "{uberProject}-{feature}",
      agentsTemplatePath: form.agentsTemplatePath.trim(),
      repos: parsed.repos,
      ...(form.virtualRootBase.trim().length > 0
        ? { virtualRootBase: form.virtualRootBase.trim() }
        : {}),
    };
    const next = editingId
      ? projects.map((entry) => (entry.id === editingId ? project : entry))
      : [...projects.filter((entry) => entry.id !== id), project];
    const ok = await saveAll(next, rootBase);
    if (ok) {
      toast.show(editingId ? "Uber-project updated" : "Uber-project added");
      cancelEdit();
    } else {
      setFormError(settings.saveError ?? "Save failed; reload and retry");
    }
  }, [form, editingId, projects, rootBase, saveAll, cancelEdit, toast, settings.saveError]);

  const deleteHandlers = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          project.id,
          async () => {
            const ok = await saveAll(
              projects.filter((entry) => entry.id !== project.id),
              rootBase,
            );
            if (ok) toast.show(`Removed ${project.id}`);
            else toast.error(settings.saveError ?? "Delete failed");
          },
        ]),
      ),
    [projects, rootBase, saveAll, toast, settings.saveError],
  );

  const editHandlers = useMemo(
    () => new Map(projects.map((project) => [project.id, () => startEdit(project)])),
    [projects, startEdit],
  );

  const handleSaveRootBasePress = useCallback(() => {
    void handleSaveRootBase();
  }, [handleSaveRootBase]);

  const handleSaveProjectPress = useCallback(() => {
    void handleSaveProject();
  }, [handleSaveProject]);

  const deletePressHandlers = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          project.id,
          () => {
            void deleteHandlers.get(project.id)?.();
          },
        ]),
      ),
    [deleteHandlers, projects],
  );

  if (settings.status === "loading") {
    return (
      <View style={styles.container}>
        <Text style={styles.hint}>Loading settings...</Text>
      </View>
    );
  }
  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <View style={styles.container}>
        <Text style={styles.error}>
          {settings.status === "error"
            ? settings.error
            : `Stored settings are invalid: ${settings.error}`}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Poly-repo settings</Text>

      <Text style={styles.label}>DEFAULT VIRTUAL ROOT</Text>
      <TextInput
        accessibilityLabel="Default virtual root base"
        placeholder="empty for $PASEO_HOME/poly-workspaces"
        value={rootBase}
        onChangeText={setRootBase}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save default root"
          onPress={handleSaveRootBasePress}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Save default root</Text>
        </Pressable>
      </View>

      <Text style={styles.label}>UBER-PROJECTS</Text>
      {projects.map((project) => (
        <View key={project.id} style={styles.row}>
          <Text style={styles.name}>{project.displayName}</Text>
          <Text style={styles.meta}>
            {project.id} · {project.repos.length} repos
          </Text>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit ${project.id}`}
              onPress={editHandlers.get(project.id)}
              style={styles.button}
            >
              <Text style={styles.buttonText}>Edit</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete ${project.id}`}
              onPress={deletePressHandlers.get(project.id)}
              style={styles.button}
            >
              <Text style={styles.buttonText}>Delete</Text>
            </Pressable>
          </View>
        </View>
      ))}

      <Text style={styles.label}>{editingId ? `EDIT ${editingId}` : "NEW UBER-PROJECT"}</Text>
      <TextInput
        accessibilityLabel="Project id"
        placeholder="id"
        value={form.id}
        onChangeText={setId}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        editable={editingId === null}
      />
      <TextInput
        accessibilityLabel="Display name"
        placeholder="Display name"
        value={form.displayName}
        onChangeText={setDisplayName}
        style={styles.input}
      />
      <TextInput
        accessibilityLabel="Branch template"
        placeholder="{feature}"
        value={form.branchTemplate}
        onChangeText={setBranchTemplate}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        accessibilityLabel="Root dir template"
        placeholder="{uberProject}-{feature}"
        value={form.rootDirTemplate}
        onChangeText={setRootDirTemplate}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        accessibilityLabel="Agents template path"
        placeholder="/abs/path/to/agents-template.md"
        value={form.agentsTemplatePath}
        onChangeText={setAgentsTemplatePath}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        accessibilityLabel="Per-project root override"
        placeholder="optional absolute path"
        value={form.virtualRootBase}
        onChangeText={setProjectRootBase}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={styles.hint}>
        Repos, one per line: id|sourcePath|dirTemplate|baseBranch (last two optional)
      </Text>
      <TextInput
        accessibilityLabel="Repos"
        placeholder={"frontend|/src/frontend\napp|/src/app||main"}
        value={form.reposText}
        onChangeText={setReposText}
        style={styles.multiline}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
      />
      {formError ? <Text style={styles.error}>{formError}</Text> : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={editingId ? "Save project" : "Add project"}
          onPress={handleSaveProjectPress}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{editingId ? "Save" : "Add"}</Text>
        </Pressable>
        {editingId ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel editing"
            onPress={cancelEdit}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Cancel</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
