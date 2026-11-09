/**
 * 0.5.0：其他插件在客户端换成自己卡片的工具调用。Paseo 按插件 id 字母序询问时间线转换器，Bots（paseo-bots）排在
 * vivid-activity 前面，会把下面两类调用换成卡片；本插件不接管它们（client/transform.ts），折叠索引把它们记成段的边界
 * （shared/fold-index.ts）。否则服务端读到的仍是普通工具调用，卡片两边的工具行会被并成一段，卡片下面的行被收进卡片上面的摘要。
 *
 * 判定照抄 Bots 0.2（github.com/oliexe/paseo-bots）：
 * - 提案卡：`shared/proposals.ts` 的 `proposalIdOf`：工具是 propose_skill／propose_routine／propose_changes，已完成，
 *   输出里有 `proposal p-xxxxxxxxxx`；
 * - 应用登录卡：`shared/apps.ts` 的 `appSignIns`：COMPOSIO_MANAGE_CONNECTIONS 已完成，输出里至少有一个 https 的
 *   composio.dev 登录链接。
 * 工具名的各种写法都认：Claude 的 `mcp__bots__propose_skill`，Codex 的 `bots.propose_skill`，其他的 `bots_propose_skill`。
 * 没装 Bots 时，这些调用由 Paseo 自己显示（同样不进折叠段）。
 */

export type PluginCard = "bots-proposal" | "bots-sign-in";

const PROPOSING_TOOL = /^(?:mcp__)?bots(?:__|\.|_)(?:propose_skill|propose_routine|propose_changes)$/;
const PROPOSAL_ID = /\bproposal (p-[a-z0-9]{10})\b/i;
const SIGN_IN_TOOL = /^(?:mcp__)?composio(?:__|\.|_)COMPOSIO_MANAGE_CONNECTIONS$/;

type CallLike = { name: string; status?: unknown; detail?: unknown };

function outputOf(detail: unknown): unknown {
  return detail && typeof detail === "object" && "output" in detail ? (detail as { output?: unknown }).output : null;
}

function hasProposalId(output: unknown): boolean {
  let text: string | undefined;
  try {
    text = typeof output === "string" ? output : JSON.stringify(output ?? null);
  } catch {
    return false;
  }
  return PROPOSAL_ID.test(text ?? "");
}

/** Composio's `data.results`, however the provider wrapped it (Bots' `composioResults`). */
function composioResults(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4 || value === null || typeof value !== "object") {
    if (typeof value !== "string" || depth > 4) return null;
    try {
      return composioResults(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return value.reduce<Record<string, unknown> | null>((found, entry) => found ?? composioResults(entry, depth + 1), null);
  const record = value as { data?: { results?: unknown }; output?: unknown; text?: unknown; content?: unknown };
  const results = record.data?.results;
  if (results && typeof results === "object" && !Array.isArray(results)) return results as Record<string, unknown>;
  return composioResults(record.output, depth + 1) ?? composioResults(record.text, depth + 1) ?? composioResults(record.content, depth + 1);
}

function isComposioUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "composio.dev" || url.hostname.endsWith(".composio.dev"));
  } catch {
    return false;
  }
}

/** The card another plugin draws for this tool call, if any. */
export function pluginCardOf(call: CallLike): PluginCard | null {
  if (call.status !== "completed") return null;
  const name = call.name.trim();
  if (PROPOSING_TOOL.test(name)) return hasProposalId(outputOf(call.detail)) ? "bots-proposal" : null;
  if (SIGN_IN_TOOL.test(name)) {
    const results = composioResults(outputOf(call.detail)) ?? {};
    return Object.values(results).some((result) => isComposioUrl((result as { redirect_url?: unknown } | null)?.redirect_url)) ? "bots-sign-in" : null;
  }
  return null;
}
