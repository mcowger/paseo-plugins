import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PiTempFile } from "./mcp-config.js";

export const PASEO_PI_TREE_EXTENSION_COMMAND = "paseo_tree";
export const PASEO_PI_CAPTURE_EXTENSION_COMMAND = "paseo_capture_entries";
export const PASEO_PI_ENTRY_CAPTURE_MARKER = "PASEO_ENTRY_CAPTURE";
export const PASEO_PI_SUBMITTED_USER_ENTRY_MARKER = "PASEO_SUBMITTED_USER_ENTRY";
export const PASEO_PI_COMMAND_RESULT_MARKER = "PASEO_COMMAND_RESULT";

/**
 * Write the paseo-integration pi extension to a temp file. The extension:
 * - appends Paseo's system prompt during before_agent_start;
 * - captures user message tree entries (ids + parent ids) for history replay
 *   and rewind;
 * - registers the internal paseo_capture_entries / paseo_tree bridge commands.
 */
export function createPiPaseoExtensionFile(systemPrompt?: string): PiTempFile {
  const dir = mkdtempSync(join(tmpdir(), "paseo-pi-extension-"));
  const filePath = join(dir, "paseo-integration.mjs");
  writeFileSync(
    filePath,
    `
	function decodePayload(encoded) {
	  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	}

	function readTextContent(content) {
	  if (typeof content === "string") {
	    return content;
	  }
	  if (!Array.isArray(content)) {
	    return "";
	  }
	  return content
	    .filter((part) => part && part.type === "text" && typeof part.text === "string")
	    .map((part) => part.text)
	    .join("\\n\\n");
	}

	function getCapturedUserEntries(ctx) {
	  return ctx.sessionManager
	    .getEntries()
	    .filter((entry) => entry.type === "message" && entry.message?.role === "user")
	    .map(toCapturedUserEntry);
	}

	function toCapturedUserEntry(entry) {
	  return {
	      id: entry.id,
	      parentId: entry.parentId ?? null,
	      text: readTextContent(entry.message.content),
	    };
	}

	function emitEntryCapture(ctx, reason, requestId) {
	  ctx.ui.notify(
	    "${PASEO_PI_ENTRY_CAPTURE_MARKER} " +
	      JSON.stringify({ reason, requestId, entries: getCapturedUserEntries(ctx) }),
	    "info",
	  );
	}

	function emitCommandResult(ctx, requestId, result) {
	  ctx.ui.notify(
	    "${PASEO_PI_COMMAND_RESULT_MARKER} " + JSON.stringify({ requestId, ...result }),
	    result.ok ? "info" : "error",
	  );
	}

	export default function paseoIntegration(pi) {
	  const submittedUserMessages = [];

	  function emitSubmittedUserEntries(ctx) {
	    const entries = ctx.sessionManager.getEntries();
	    for (let index = 0; index < submittedUserMessages.length; index += 1) {
	      const message = submittedUserMessages[index];
	      // Pi assigns the entry ID after message_end, then persists this same message object.
	      // Reference equality preserves the exact association even when another extension edits it.
	      const entry = entries.find(
	        (candidate) => candidate.type === "message" && candidate.message === message,
	      );
	      if (!entry) {
	        continue;
	      }
	      submittedUserMessages.splice(index, 1);
	      index -= 1;
	      ctx.ui.notify(
	        "${PASEO_PI_SUBMITTED_USER_ENTRY_MARKER} " +
	          JSON.stringify({ entry: toCapturedUserEntry(entry) }),
	        "info",
	      );
	    }
	  }

	  ${
      systemPrompt
        ? `pi.on("before_agent_start", async (event) => ({
	    systemPrompt: event.systemPrompt + "\\n\\n" + ${JSON.stringify(systemPrompt)},
	  }));`
        : ""
    }

	  pi.on("session_start", async (_event, ctx) => {
	    emitEntryCapture(ctx, "session_start");
	  });

	  pi.on("message_end", async (event) => {
	    if (event.message?.role === "user") {
	      submittedUserMessages.push(event.message);
	    }
	  });

	  pi.on("message_start", async (event, ctx) => {
	    if (event.message?.role === "assistant") {
	      emitSubmittedUserEntries(ctx);
	    }
	  });

	  pi.on("turn_end", async (_event, ctx) => {
	    emitSubmittedUserEntries(ctx);
	    emitEntryCapture(ctx, "turn_end");
	  });

	  pi.registerCommand("${PASEO_PI_CAPTURE_EXTENSION_COMMAND}", {
	    description: "Internal Paseo entry capture bridge",
	    handler: async (args, ctx) => {
	      const payload = decodePayload(args.trim());
	      emitEntryCapture(ctx, "command", payload.requestId);
	    },
	  });

	  pi.registerCommand("${PASEO_PI_TREE_EXTENSION_COMMAND}", {
	    description: "Internal Paseo tree navigation bridge",
	    handler: async (args, ctx) => {
	      const payload = decodePayload(args.trim());
	      try {
	        const result = await ctx.navigateTree(payload.targetId, { summarize: false });
	        emitEntryCapture(ctx, "tree_navigation");
	        emitCommandResult(ctx, payload.requestId, { ok: true, result });
	      } catch (error) {
	        const message = error instanceof Error ? error.message : String(error);
	        emitCommandResult(ctx, payload.requestId, { ok: false, error: message });
	        throw error;
	      }
	    },
	  });
	}
`.trimStart(),
    "utf8",
  );
  return {
    path: filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
