import { useEffect, useState } from "react";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { refreshText, t } from "../shared/i18n";
import { i18nLanguagesRpc, languageSettings } from "../shared/i18n-settings";
import { deviceLanguage, useI18n } from "./i18n-client";

interface Issue { code: string; id?: string; detail?: string }
interface LanguageOption { code: string; name: string; builtIn: boolean; custom: boolean; file?: string; coverage: number; issues: Issue[] }
interface Languages { setting: string; resolved: string; system: string; device: string; folder: string; languages: LanguageOption[] }

const ISSUE_MESSAGES: { readonly [code: string]: string } = {
  notObject: "kitLanguage.issueNotObject",
  notSection: "kitLanguage.issueNotSection",
  unknownMessage: "kitLanguage.issueUnknownMessage",
  badShape: "kitLanguage.issueBadShape",
  tooLong: "kitLanguage.issueTooLong",
  badPlaceholder: "kitLanguage.issueBadPlaceholder",
  link: "kitLanguage.issueLink",
  open: "kitLanguage.issueOpen",
  notFile: "kitLanguage.issueNotFile",
  tooBig: "kitLanguage.issueTooBig",
  badJson: "kitLanguage.issueBadJson",
};
const issueText = (issue: Issue) => t(ISSUE_MESSAGES[issue.code] ?? "kitLanguage.issueBadShape", { id: issue.id ?? "", detail: issue.detail ?? "" });
type Listing = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; data: Languages };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error ?? ""));

/**
 * The Language section of a plugin's settings: follow the system or pick a language, see which translations the
 * language folder holds and what is wrong with them. Uses the host's settings controls, like Paseo's own pages.
 */
export function LanguageSettings() {
  useI18n();
  const settings = useSettings(languageSettings);
  const listLanguages = useRpc(i18nLanguagesRpc);
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [reads, setReads] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listLanguages({ device: deviceLanguage() }).then(
      (data) => { if (live) setListing({ status: "ready", data }); },
      (error: unknown) => { if (live) setListing({ status: "error", error: errorText(error) }); },
    );
    return () => { live = false; };
  }, [reads]);

  const reread = () => {
    setReads((value) => value + 1);
    void refreshText();
  };
  const choose = async (language: string) => {
    if (settings.status !== "ready") return;
    setSaveError(null);
    const saved = await settings.save({ ...settings.values, language }, settings.revision);
    if (!saved) {
      setSaveError(t("kitLanguage.saveFailed", { error: settings.saveError ?? "" }));
      return;
    }
    reread();
  };

  const data = listing.status === "ready" ? listing.data : null;
  const value = settings.status === "ready" ? settings.values.language : data?.setting ?? "auto";
  const languages = data?.languages ?? [];
  const nameOf = (code: string) => languages.find((language) => language.code === code)?.name ?? code;
  const options = [
    { value: "auto", label: t("kitLanguage.auto", { name: nameOf(data?.system ?? "") }) },
    ...languages.map((language) => ({
      value: language.code,
      label: !language.builtIn ? t("kitLanguage.custom", { name: language.name, percent: Math.round(language.coverage * 100) })
        : language.custom ? t("kitLanguage.customOverride", { name: language.name })
        : language.name,
    })),
  ];
  // A chosen language whose file is gone stays selectable, so the control never shows an empty choice.
  if (!options.some((option) => option.value === value)) options.push({ value, label: value });
  const withIssues = languages.filter((language) => language.issues.length > 0);

  return (
    <SettingsSection title={t("kitLanguage.title")}>
      <SettingsCard>
        <SettingsSelect
          label={t("kitLanguage.label")}
          hint={t("kitLanguage.hint")}
          value={value}
          options={options}
          onValueChange={(next) => void choose(next)}
          disabled={settings.status !== "ready" || settings.saving}
          error={saveError ?? (listing.status === "error" ? t("kitLanguage.loadFailed", { error: listing.error }) : null)}
        />
        {withIssues.map((language) => (
          <SettingsRow key={language.code} label={t("kitLanguage.issuesLabel", { file: language.file ?? `${language.code}.json` })} hint={language.issues.map(issueText).join("\n")} />
        ))}
        <SettingsRow label={t("kitLanguage.folderLabel")} hint={data ? t("kitLanguage.folderHint", { folder: data.folder }) : t("kitLanguage.loading")} />
        <SettingsAction label={t("kitLanguage.rescanLabel")} actionLabel={t("kitLanguage.rescan")} onPress={reread} />
      </SettingsCard>
    </SettingsSection>
  );
}
