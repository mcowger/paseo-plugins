import type { PluginTheme } from "@getpaseo/plugin";
import { useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, type TextStyle, View, type ViewStyle } from "react-native";
import type { UberProject } from "../shared/config";
import { polyrepoSettings } from "../shared/settings";
import {
  DEFAULT_BRANCH_TEMPLATE,
  DEFAULT_REPO_DIR_TEMPLATE,
  DEFAULT_ROOT_DIR_TEMPLATE,
  emptyProjectDraft,
  emptyRepoDraft,
  hasProjectErrors,
  PREVIEW_FEATURE,
  type ProjectDraft,
  previewProjectDraft,
  projectDraftFrom,
  projectFromDraft,
  type RepoDraft,
  validateProjectDraft,
} from "../shared/settings-form";

interface SettingsStyles {
  readonly rowActions: ViewStyle;
  readonly button: ViewStyle;
  readonly buttonText: TextStyle;
  readonly dangerButtonText: TextStyle;
  readonly preview: ViewStyle;
  readonly previewLine: ViewStyle;
  readonly previewLabel: TextStyle;
  readonly previewValue: TextStyle;
}

function createStyles(theme: PluginTheme, compact: boolean): SettingsStyles {
  const small = compact ? 10 : 11;
  return {
    rowActions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
    button: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 6,
      backgroundColor: theme.colors.surface2,
    },
    buttonText: { color: theme.colors.foreground, fontSize: small, fontWeight: "600" },
    dangerButtonText: { color: theme.colors.statusDanger, fontSize: small, fontWeight: "600" },
    preview: { gap: 2, minWidth: 180 },
    previewLine: { flexDirection: "row", gap: 8 },
    previewLabel: { color: theme.colors.foregroundMuted, fontSize: small, minWidth: 64 },
    previewValue: { color: theme.colors.foreground, fontSize: small, flexShrink: 1 },
  };
}

const EMPTY_PROJECTS: readonly UberProject[] = [];

const ROOT_BASE_HINT =
  "Absolute folder that holds every virtual workspace. Leave empty for $PASEO_HOME/poly-workspaces. " +
  "It cannot live inside Paseo's worktrees folder.";

const REPO_FIELDS = [
  {
    field: "id",
    suffix: "id",
    hint: "Short name used by this repo's folder template ({repo}). Lowercase letters, numbers, hyphens.",
    placeholder: "frontend",
  },
  {
    field: "sourcePath",
    suffix: "source path",
    hint: "Absolute path to the repo's main checkout. Worktrees are created from it; the checkout itself is never modified.",
    placeholder: "/home/me/src/frontend",
  },
  {
    field: "dirTemplate",
    suffix: "folder template",
    hint: `Folder name inside the workspace. Tokens: {repo}, {uberProject}, {feature}, {branch}. Leave empty for ${DEFAULT_REPO_DIR_TEMPLATE}.`,
    placeholder: DEFAULT_REPO_DIR_TEMPLATE,
  },
  {
    field: "baseBranch",
    suffix: "base branch",
    hint: "Branch the new worktree is cut from. Leave empty to use the repo's origin/HEAD.",
    placeholder: "main",
  },
] as const;

function PreviewLine({
  styles,
  label,
  value,
}: {
  styles: SettingsStyles;
  label: string;
  value: string;
}): ReactElement {
  return (
    <View style={styles.previewLine}>
      <Text style={styles.previewLabel}>{label}</Text>
      <Text style={styles.previewValue}>{value}</Text>
    </View>
  );
}

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

  // `SettingsInput` reads `initialValue` only when it mounts, so the draft has to be
  // seeded from the stored settings before that input renders. `null` means "not seeded".
  const [rootBase, setRootBase] = useState<string | null>(null);
  const [form, setForm] = useState<ProjectDraft>(() => emptyProjectDraft());
  const [formVersion, setFormVersion] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const repoKeySeq = useRef(0);

  useEffect(() => {
    if (settings.status !== "ready" || rootBase !== null) return;
    setRootBase(settings.values.virtualRootBase ?? "");
  }, [settings, rootBase]);

  const projects: readonly UberProject[] = useMemo(
    () => (settings.status === "ready" ? settings.values.uberProjects : EMPTY_PROJECTS),
    [settings],
  );

  const errors = useMemo(() => {
    const takenIds = projects.filter((project) => project.id !== editingId).map((p) => p.id);
    return validateProjectDraft(form, takenIds);
  }, [form, projects, editingId]);

  const preview = useMemo(() => previewProjectDraft(form, PREVIEW_FEATURE), [form]);

  const patchForm = useCallback((update: Partial<ProjectDraft>) => {
    setForm((prev) => ({ ...prev, ...update }));
    setSaveError(null);
  }, []);

  const patchRepo = useCallback((key: string, update: Partial<RepoDraft>) => {
    setForm((prev) => ({
      ...prev,
      repos: prev.repos.map((repo) => (repo.key === key ? { ...repo, ...update } : repo)),
    }));
    setSaveError(null);
  }, []);

  const addRepo = useCallback(() => {
    repoKeySeq.current += 1;
    const key = `new-${repoKeySeq.current}`;
    setForm((prev) => ({ ...prev, repos: [...prev.repos, emptyRepoDraft(key)] }));
  }, []);

  const removeRepo = useCallback((key: string) => {
    setForm((prev) => ({ ...prev, repos: prev.repos.filter((repo) => repo.key !== key) }));
    setSaveError(null);
  }, []);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setForm(emptyProjectDraft());
    setAttempted(false);
    setSaveError(null);
    setFormVersion((version) => version + 1);
    setFormOpen(false);
  }, []);

  const startCreate = useCallback(() => {
    setEditingId(null);
    setForm(emptyProjectDraft());
    setAttempted(false);
    setSaveError(null);
    setConfirmDeleteId(null);
    setFormVersion((version) => version + 1);
    setFormOpen(true);
  }, []);

  const startEdit = useCallback((project: UberProject) => {
    repoKeySeq.current += 1;
    setEditingId(project.id);
    setForm(projectDraftFrom(project, `edit-${project.id}-${repoKeySeq.current}`));
    setAttempted(false);
    setSaveError(null);
    setConfirmDeleteId(null);
    setFormVersion((version) => version + 1);
    setFormOpen(true);
  }, []);

  const saveAll = useCallback(
    async (nextProjects: UberProject[], nextRootBase: string | null) => {
      if (settings.status !== "ready") return false;
      const trimmedRoot = nextRootBase?.trim() ?? "";
      return settings.save(
        {
          virtualRootBase: trimmedRoot.length > 0 ? trimmedRoot : undefined,
          uberProjects: nextProjects,
        },
        settings.revision,
      );
    },
    [settings],
  );

  const handleSaveRootBase = useCallback(() => {
    void (async () => {
      const ok = await saveAll([...projects], rootBase);
      if (ok) toast.show("Default virtual root saved");
      else toast.error(settings.saveError ?? "Save failed; reload and retry");
    })();
  }, [saveAll, projects, rootBase, toast, settings.saveError]);

  const handleSaveProject = useCallback(() => {
    void (async () => {
      setAttempted(true);
      setSaveError(null);
      if (hasProjectErrors(errors)) {
        setSaveError("Fix the highlighted fields before saving.");
        return;
      }
      const project = projectFromDraft(form);
      const next = editingId
        ? projects.map((entry) => (entry.id === editingId ? project : entry))
        : [...projects, project];
      const ok = await saveAll(next, rootBase);
      if (ok) {
        toast.show(editingId ? `Saved ${project.displayName}` : `Added ${project.displayName}`);
        resetForm();
      } else {
        setSaveError(settings.saveError ?? "Save failed; reload and retry.");
      }
    })();
  }, [errors, form, editingId, projects, rootBase, saveAll, resetForm, toast, settings.saveError]);

  const handleDeleteProject = useCallback(
    (project: UberProject) => {
      void (async () => {
        const ok = await saveAll(
          projects.filter((entry) => entry.id !== project.id),
          rootBase,
        );
        setConfirmDeleteId(null);
        if (ok) {
          if (editingId === project.id) resetForm();
          toast.show(`Removed ${project.displayName}`);
        } else {
          toast.error(settings.saveError ?? "Delete failed");
        }
      })();
    },
    [saveAll, projects, rootBase, editingId, resetForm, toast, settings.saveError],
  );

  if (settings.status === "loading") {
    return (
      <SettingsSection title="Poly-repo">
        <SettingsCard>
          <SettingsRow label="Loading settings…" />
        </SettingsCard>
      </SettingsSection>
    );
  }
  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <SettingsSection title="Poly-repo">
        <SettingsCard>
          <SettingsRow
            label="Stored settings could not be read"
            error={
              settings.status === "error"
                ? settings.error
                : `Invalid stored settings: ${settings.error}`
            }
          />
          <SettingsAction
            label="Try again"
            actionLabel="Reload"
            onPress={() => {
              void settings.reload();
            }}
          />
          {settings.status === "invalid" ? (
            <SettingsAction
              label="Replace the stored settings with defaults"
              actionLabel="Reset"
              onPress={() => {
                void settings.reset();
              }}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }

  if (rootBase === null) {
    return (
      <SettingsSection title="Poly-repo">
        <SettingsCard>
          <SettingsRow label="Loading settings…" />
        </SettingsCard>
      </SettingsSection>
    );
  }

  const showError = (message: string | undefined): string | null | undefined =>
    attempted ? message : null;

  return (
    <View>
      <SettingsSection
        title="Virtual workspace storage"
        info="Each virtual workspace is one folder holding a git worktree per repo. This is where those folders are created."
      >
        <SettingsCard>
          <SettingsInput
            label="Default virtual root"
            hint={ROOT_BASE_HINT}
            initialValue={rootBase}
            onChangeText={setRootBase}
            placeholder="$PASEO_HOME/poly-workspaces"
          />
          <SettingsAction
            label="Default root changes"
            hint="Only affects workspaces created from now on. Existing workspaces stay where they are."
            actionLabel="Save default root"
            onPress={handleSaveRootBase}
          />
        </SettingsCard>
      </SettingsSection>

      {formOpen ? null : (
        <SettingsSection
          title="Uber-projects"
          info="An uber-project groups repos that ship together: where each checkout lives, and how branch and folder names are built when you create a workspace from it."
        >
          <SettingsCard>
            {projects.length === 0 ? (
              <SettingsRow
                label="No uber-projects yet"
                hint="An uber-project lists the repos you work on together. Add one below."
              />
            ) : (
              projects.map((project) => (
                <SettingsRow
                  key={project.id}
                  label={project.displayName}
                  hint={
                    confirmDeleteId === project.id
                      ? `Delete ${project.id}? Its ${project.repos.length} repo entries are removed from this config. Existing workspaces are not touched.`
                      : `${project.id} · ${project.repos.length} repo${project.repos.length === 1 ? "" : "s"}: ${
                          project.repos.map((repo) => repo.id).join(", ") || "none yet"
                        }${editingId === project.id ? " · editing below" : ""}`
                  }
                  error={confirmDeleteId === project.id ? "This cannot be undone." : null}
                >
                  <View style={styles.rowActions}>
                    {confirmDeleteId === project.id ? (
                      <>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Confirm delete ${project.id}`}
                          onPress={() => handleDeleteProject(project)}
                          style={styles.button}
                        >
                          <Text style={styles.dangerButtonText}>Delete</Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Keep ${project.id}`}
                          onPress={() => setConfirmDeleteId(null)}
                          style={styles.button}
                        >
                          <Text style={styles.buttonText}>Keep</Text>
                        </Pressable>
                      </>
                    ) : (
                      <>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Edit ${project.id}`}
                          onPress={() => startEdit(project)}
                          style={styles.button}
                        >
                          <Text style={styles.buttonText}>Edit</Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Delete ${project.id}`}
                          onPress={() => {
                            setConfirmDeleteId(project.id);
                          }}
                          style={styles.button}
                        >
                          <Text style={styles.dangerButtonText}>Delete</Text>
                        </Pressable>
                      </>
                    )}
                  </View>
                </SettingsRow>
              ))
            )}
          </SettingsCard>

          <SettingsCard>
            <SettingsAction
              label="Add uber-project"
              hint="Opens the uber-project form. Repositories are added after the basic fields."
              actionLabel="Add uber-project"
              onPress={startCreate}
            />
          </SettingsCard>
        </SettingsSection>
      )}

      {formOpen ? (
        <>
          <SettingsSection
            title={editingId ? `Edit ${editingId}` : "New uber-project"}
            info="Every repo listed here becomes its own worktree inside the workspace. Nothing is written to the source checkouts."
          >
            <SettingsCard key={`details-${formVersion}`}>
              <SettingsInput
                label="Id"
                hint="Short identifier used inside folder and branch templates. Lowercase letters, numbers, hyphens. It cannot be changed later."
                initialValue={form.id}
                onChangeText={(value) => patchForm({ id: value })}
                placeholder="checkout"
                disabled={editingId !== null}
                error={showError(errors.id)}
              />
              <SettingsInput
                label="Display name"
                hint="Shown in Paseo's workspace lists and used as the workspace title."
                initialValue={form.displayName}
                onChangeText={(value) => patchForm({ displayName: value })}
                placeholder="Checkout"
                error={showError(errors.displayName)}
              />
              <SettingsInput
                label="Branch template"
                hint={`Branch created in every repo. {feature} is the feature name typed at creation time. Leave empty for ${DEFAULT_BRANCH_TEMPLATE}.`}
                initialValue={form.branchTemplate}
                onChangeText={(value) => patchForm({ branchTemplate: value })}
                placeholder={DEFAULT_BRANCH_TEMPLATE}
              />
              <SettingsInput
                label="Workspace folder template"
                hint={`Folder name of the virtual workspace, created under the virtual root. Tokens: {uberProject}, {feature}, {branch}. Leave empty for ${DEFAULT_ROOT_DIR_TEMPLATE}.`}
                initialValue={form.rootDirTemplate}
                onChangeText={(value) => patchForm({ rootDirTemplate: value })}
                placeholder={DEFAULT_ROOT_DIR_TEMPLATE}
              />
              <SettingsInput
                label="AGENTS.md template"
                hint="Absolute path to a Markdown file copied into each workspace root as AGENTS.md. Tokens: {{feature}}, {{branch}}, {{uberProject}}, {{repos}}."
                initialValue={form.agentsTemplatePath}
                onChangeText={(value) => patchForm({ agentsTemplatePath: value })}
                placeholder="/home/me/AGENTS.template.md"
                error={showError(errors.agentsTemplatePath)}
              />
              <SettingsInput
                label="Root override"
                hint="Optional absolute path used for this uber-project only. Overrides the default virtual root above."
                initialValue={form.virtualRootBase}
                onChangeText={(value) => patchForm({ virtualRootBase: value })}
                placeholder="Uses the default virtual root"
                error={showError(errors.virtualRootBase)}
              />
            </SettingsCard>
          </SettingsSection>

          <SettingsSection
            title="Repositories"
            info="Each repo gets one git worktree inside the workspace. The order here is the order worktrees are created in."
          >
            {form.repos.length === 0 ? (
              <SettingsCard>
                <SettingsRow
                  label="No repositories yet"
                  hint="An uber-project needs the repos it spans. Add them one at a time."
                />
              </SettingsCard>
            ) : null}
            {form.repos.map((repo, index) => {
              const repoErrors = attempted ? errors.repoErrors[repo.key] : undefined;
              const name = repo.id.trim().length > 0 ? repo.id.trim() : `Repository ${index + 1}`;
              return (
                <SettingsCard key={`${formVersion}-${repo.key}`}>
                  {REPO_FIELDS.map((spec) => (
                    <SettingsInput
                      key={spec.field}
                      label={`${name} ${spec.suffix}`}
                      hint={spec.hint}
                      initialValue={repo[spec.field]}
                      onChangeText={(value) => patchRepo(repo.key, { [spec.field]: value })}
                      placeholder={spec.placeholder}
                      error={
                        spec.field === "id"
                          ? (repoErrors?.id ?? null)
                          : spec.field === "sourcePath"
                            ? (repoErrors?.sourcePath ?? null)
                            : null
                      }
                    />
                  ))}
                  <SettingsAction
                    label={`Remove ${name}`}
                    hint={
                      form.repos.length <= 1
                        ? "An uber-project needs at least one repository."
                        : undefined
                    }
                    actionLabel="Remove"
                    disabled={form.repos.length <= 1}
                    onPress={() => removeRepo(repo.key)}
                  />
                </SettingsCard>
              );
            })}
            <SettingsCard>
              {attempted && errors.repos ? (
                <SettingsRow label="Repositories" error={errors.repos} />
              ) : null}
              <SettingsAction
                label="Add repository"
                hint="Adds one repo to this uber-project. Repeat for each repo it spans."
                actionLabel="Add repository"
                onPress={addRepo}
              />
            </SettingsCard>
          </SettingsSection>

          <SettingsSection
            title="Preview"
            info="How the templates resolve. Existing workspaces keep the folder names recorded when they were created."
          >
            <SettingsCard key={`preview-${formVersion}`}>
              <SettingsRow
                label="Workspace names"
                hint={`A workspace created with the feature "${PREVIEW_FEATURE}" gets these.`}
              >
                <View style={styles.preview}>
                  <PreviewLine styles={styles} label="branch" value={preview.branch} />
                  <PreviewLine styles={styles} label="folder" value={`${preview.rootDir}/`} />
                  {preview.repos.map((entry) => (
                    <PreviewLine
                      key={entry.id}
                      styles={styles}
                      label={entry.id}
                      value={`  ${entry.dir}/`}
                    />
                  ))}
                </View>
              </SettingsRow>
            </SettingsCard>
          </SettingsSection>

          <SettingsCard>
            {saveError ? <SettingsRow label="Cannot save" error={saveError} /> : null}
            <SettingsAction
              label={editingId ? "Save your changes" : "Add this uber-project"}
              hint="Saved on this host only."
              actionLabel={editingId ? "Save uber-project" : "Add uber-project"}
              onPress={handleSaveProject}
            />
            <SettingsAction
              label="Discard and return to the list"
              actionLabel="Cancel"
              onPress={resetForm}
            />
          </SettingsCard>
        </>
      ) : null}
    </View>
  );
}
