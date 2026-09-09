import type { PiHeadlessUiContext } from "../shared/pi-sdk-types.js";

export type PiUiDialogMethod = "select" | "confirm" | "input" | "editor";

export interface PiUiDialogRequest {
  method: PiUiDialogMethod;
  title?: string;
  message?: string;
  placeholder?: string;
  options?: string[];
}

export type PiUiDialogResponse =
  | { kind: "value"; value: string }
  | { kind: "confirmed"; confirmed: boolean }
  | { kind: "cancelled" };

export interface PiUiBridgeHandlers {
  requestDialog(request: PiUiDialogRequest): Promise<PiUiDialogResponse>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

/**
 * Headless pi ExtensionUIContext: dialogs become Paseo permission questions,
 * notifications become timeline notification items. Everything TUI-specific
 * (widgets, footers, custom components, editor) is a no-op or rejected.
 */
export function createHeadlessUiContext(handlers: PiUiBridgeHandlers): PiHeadlessUiContext {
  return {
    async select(title: string, options: string[]) {
      const response = await handlers.requestDialog({ method: "select", title, options });
      return response.kind === "value" ? response.value : undefined;
    },
    async confirm(title: string, message: string) {
      const response = await handlers.requestDialog({ method: "confirm", title, message });
      return response.kind === "confirmed" ? response.confirmed : false;
    },
    async input(title: string, placeholder?: string) {
      const response = await handlers.requestDialog({ method: "input", title, placeholder });
      return response.kind === "value" ? response.value : undefined;
    },
    async editor(title: string, prefill?: string) {
      const response = await handlers.requestDialog({
        method: "editor",
        title,
        placeholder: prefill,
      });
      return response.kind === "value" ? response.value : undefined;
    },
    notify(message: string, type?: string) {
      handlers.notify(message, type === "warning" || type === "error" ? type : "info");
    },

    onTerminalInput() {
      return () => {};
    },
    setStatus() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    async custom() {
      throw new Error("Interactive custom UI is not available in this host");
    },
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() {
      return "";
    },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {
      return undefined;
    },
    // Theme is TUI styling; hand extensions a harmless callable stub.
    get theme(): never {
      return new Proxy(
        {},
        { get: () => () => "" },
      ) as never;
    },
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "Themes are unavailable in this host" };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  } as PiHeadlessUiContext;
}
