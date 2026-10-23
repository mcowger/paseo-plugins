import * as hostUi from "@getpaseo/plugin/client/react-native";
import type { ComponentType } from "react";

/**
 * Paseo draws its own assistant rows with a native Markdown renderer, and 0.13
 * exposes that renderer to plugins as `Markdown` from the UI entry. 0.12 has no
 * such export, so detect it and let older hosts keep the plugin's block
 * renderer instead of rendering nothing.
 */

export interface HostMarkdownProps {
  /** A Markdown document. The host supplies theme, selection, and link handling. */
  children: string;
}

export type HostMarkdownRenderer = ComponentType<HostMarkdownProps>;

/** The host renderer when it exists, otherwise null. */
export function pickHostMarkdown(candidate: unknown): HostMarkdownRenderer | null {
  return typeof candidate === "function" ? (candidate as HostMarkdownRenderer) : null;
}

export const HostMarkdown: HostMarkdownRenderer | null = pickHostMarkdown(
  (hostUi as { Markdown?: unknown }).Markdown,
);
