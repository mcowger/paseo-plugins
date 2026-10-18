import type { TextProps, ViewProps } from "react-native";
import { Platform } from "react-native";
import { rule, sunken } from "../shared/color";

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

interface DomElement {
  id: string;
  textContent: string | null;
  remove(): void;
}

declare const document:
  | {
      createElement(tag: string): DomElement;
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

export interface ReplyCodePalette {
  surface0: string;
  surface2: string;
  border: string;
  foreground: string;
  foregroundMuted: string;
}

const REPLY_CODE_STYLE_ID = "colorful-reply-code";
const REPLY_MESSAGE = '[data-testid="assistant-message"]';
const REPLY_INLINE_CODE = `${REPLY_MESSAGE} span[data-paseo-markdown-tag="code"]`;
const REPLY_CODE_BLOCK = `${REPLY_MESSAGE} [data-paseo-markdown-tag="pre"]`;
// Paseo sets the language attribute only when the fence names one; the guard keeps the header off bare fences.
const REPLY_CODE_LANG = `${REPLY_CODE_BLOCK}[data-paseo-markdown-language]:not([data-paseo-markdown-language=""])`;
// Paseo keeps the copy control hidden until the block is hovered; the label is
// English-only, so other locales keep the host's own placement.
const REPLY_COPY = 'button[aria-label="Copy code"]';

/**
 * CSS that restyles assistant-reply inline code and fenced code blocks, derived
 * from the palette. Declarations carry `!important` because React Native Web sets
 * these properties atomically on each element.
 */
export function replyCodeCss(palette: ReplyCodePalette): string {
  const block = sunken(palette.surface0);
  const edge = rule(palette.border);
  return [
    `${REPLY_INLINE_CODE} { background: ${palette.surface2} !important; border-radius: 4px !important; padding: 1px 4px !important; font-family: ${MONO_STACK} !important; color: ${palette.foreground} !important; }`,
    `${REPLY_CODE_BLOCK} { background: ${block} !important; border: 1px solid ${edge} !important; border-radius: 8px !important; padding: 12px 14px !important; }`,
    `${REPLY_CODE_LANG} { padding-top: 0 !important; }`,
    `${REPLY_CODE_LANG}::before { content: attr(data-paseo-markdown-language); display: block; margin: 0 -14px 10px; padding: 7px 14px; border-bottom: 1px solid ${edge}; font-family: ${MONO_STACK}; font-size: 12px; line-height: 18px; color: ${palette.foregroundMuted}; }`,
    `${REPLY_CODE_LANG} > ${REPLY_COPY} { opacity: 0.6 !important; pointer-events: auto !important; top: 5px !important; }`,
    `${REPLY_CODE_LANG} > ${REPLY_COPY}:hover { opacity: 1 !important; }`,
  ].join("\n");
}

/** Identity of a palette, so callers can skip re-installing an unchanged stylesheet. */
export function replyCodeStyleKey(palette: ReplyCodePalette): string {
  return [
    palette.surface0,
    palette.surface2,
    palette.border,
    palette.foreground,
    palette.foregroundMuted,
  ].join("|");
}

/**
 * Installs the reply code styles, or removes them when `palette` is null. Web-only:
 * a no-op elsewhere. Returns a remover that is safe to call more than once.
 */
export function installReplyCodeStyles(palette: ReplyCodePalette | null): () => void {
  if (Platform.OS !== "web") return () => {};
  if (typeof document === "undefined") return () => {};

  const removeStyle = () => {
    const node = document.getElementById(REPLY_CODE_STYLE_ID) as DomElement | null;
    if (node) node.remove();
  };
  if (palette === null) {
    removeStyle();
    return () => {};
  }

  let style = document.getElementById(REPLY_CODE_STYLE_ID) as DomElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = REPLY_CODE_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = replyCodeCss(palette);

  return removeStyle;
}
