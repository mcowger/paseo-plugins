import { Platform } from "react-native";
import type { TextProps, ViewProps } from "react-native";

// System font stacks: zero bytes over the wire, resolving to each OS's newest
// built-in faces (SF Pro/SF Mono on Apple, Segoe UI Variable on Windows 11,
// Roboto on Android/ChromeOS). `ui-monospace` is Safari 13.1+, Chromium 106+,
// Firefox 92+; unknown keywords are skipped left-to-right, so the named
// fallbacks are load-bearing on older engines.
const UI_STACK =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", Arial, sans-serif';
const MONO_STACK =
  'ui-monospace, "SF Mono", "Cascadia Code", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace';

const STYLE_ELEMENT_ID = "colorful-activity-fonts";

/**
 * Opts a subtree out of the host's global font rule. Paseo forces its own UI
 * font onto everything except `[data-pmono]` subtrees, so a card root carrying
 * this keeps the plugin's own stacks. On native the prop is ignored, where the
 * `fontFamily: "monospace"` styles apply unchanged.
 */
export const pmonoViewEscape = {
  dataSet: { pmono: true },
} as unknown as ViewProps;

/** Marks UI-sans text (headers, prose). Ties resolve by stylesheet order. */
export const cuiTextEscape = {
  dataSet: { cui: true },
} as unknown as TextProps;

/** Marks UI-sans subtrees (reasoning prose): wins over the mono container. */
export const cuiViewEscape = {
  dataSet: { cui: true },
} as unknown as ViewProps;

/** Marks mono subtrees (code, diffs): declared last, so it wins ties. */
export const cmonoViewEscape = {
  dataSet: { cmono: true },
} as unknown as ViewProps;

/** Marks inline code spans inside sans prose: mono always wins. */
export const cmonoTextEscape = {
  dataSet: { cmono: true },
} as unknown as TextProps;

declare const document:
  | {
      createElement(tag: string): { id: string; textContent: string | null };
      getElementById(id: string): unknown | null;
      head: { appendChild(node: unknown): void };
    }
  | undefined;

/**
 * Installs the plugin's font stacks. Web-only: a no-op on native, where the
 * `fontFamily` styles apply. The doubled attribute selectors outscore React
 * Native Web's atomic classes without `!important`; `data-pmono` on card roots
 * excludes the subtree from the host's `--paseo-ui-font` rule.
 */
export function installColorfulFonts(): () => void {
  if (Platform.OS !== "web") return () => {};
  if (typeof document === "undefined") return () => {};
  if (document.getElementById(STYLE_ELEMENT_ID)) return () => {};

  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = [
    `[data-cui][data-cui], [data-cui][data-cui] * { font-family: ${UI_STACK}; }`,
    `[data-cmono][data-cmono], [data-cmono][data-cmono] * { font-family: ${MONO_STACK}; }`,
  ].join("\n");
  document.head.appendChild(style);

  return () => {
    const node = document.getElementById(STYLE_ELEMENT_ID);
    if (node && typeof (node as { remove?: unknown }).remove === "function") {
      (node as { remove: () => void }).remove();
    }
  };
}
