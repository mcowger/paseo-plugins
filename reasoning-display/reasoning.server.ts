import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  DEFAULT_REASONING_SETTINGS,
  reasoningSettingsSchema,
  type ReasoningSettings,
} from "./reasoning.shared";

const settingsPath = path.join(
  process.env.PASEO_HOME ?? path.join(homedir(), ".paseo"),
  "plugin-data",
  "reasoning-display.json",
);

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

async function readSettings(): Promise<ReasoningSettings> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { ...DEFAULT_REASONING_SETTINGS };
    }
    throw error;
  }

  try {
    const parsed = reasoningSettingsSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : { ...DEFAULT_REASONING_SETTINGS };
  } catch {
    return { ...DEFAULT_REASONING_SETTINGS };
  }
}

async function writeSettings(settings: ReasoningSettings): Promise<void> {
  const directory = path.dirname(settingsPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(settings)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, settingsPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function getReasoningSettings(): Promise<ReasoningSettings> {
  return readSettings();
}

export async function setReasoningSettings(
  settings: ReasoningSettings,
): Promise<ReasoningSettings> {
  await writeSettings(settings);
  return settings;
}
