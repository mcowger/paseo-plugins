import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { LANGUAGE_SETTINGS_ID } from "./i18n-rpc";

/**
 * The Language setting and what the settings view lists; kept out of the resident stub (`i18n-rpc.ts` has the rest).
 * "auto" follows the device's language; anything else is a language code such as "en", "zh-CN" or "ko".
 */
export const languageSettings = defineSettings({
  id: LANGUAGE_SETTINGS_ID,
  scope: "host",
  version: 1,
  schema: z.object({ language: z.string().max(40).default("auto") }),
});

const device = z.string().max(80);
const language = z.string().max(40);

/** For the Language setting: what can be chosen, what "follow system" means here, and where translations go. */
export const i18nLanguagesRpc = defineRpc({
  name: "i18n.languages",
  input: z.object({ device }).strict(),
  output: z.object({
    setting: z.string(),
    /** The language in use with this setting on the asking device. */
    resolved: language,
    /** What "follow system" means on the asking device. */
    system: language,
    device: z.string(),
    folder: z.string(),
    languages: z.array(z.object({
      code: language,
      name: z.string(),
      builtIn: z.boolean(),
      /** A file in the folder: a new language, or changes to a built-in one. */
      custom: z.boolean(),
      file: z.string().optional(),
      /** Share of the plugin's messages this language has, 0 to 1 (built-in languages: 1). */
      coverage: z.number().min(0).max(1),
      /** Problems found in the file; codes are worded by the client (`kitLanguage.issue…`). */
      issues: z.array(z.object({ code: z.string(), id: z.string().optional(), detail: z.string().optional() })),
    })),
  }),
});
