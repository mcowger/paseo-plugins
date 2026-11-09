import { createLocaleService } from "./server/i18n-server";
import { BUILTIN_CATALOGS } from "./server/locales";
import { getUiChunk } from "./server/ui-chunk";
import { getClientChunk } from "./shared/ui-chunk";
import { handleChildSummary } from "./server/child-summary";
import { childSummaryRpc } from "./shared/child-summary";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { forgetAgentTurns, handleFoldIndex, noteAgentClosed, noteTurnStarted, turnName } from "./server/fold-index.js";
import { createProviderBases } from "./server/provider-base.js";
import { handleReadImage } from "./server/read-image.js";
import { handleTurnPrompt } from "./server/turn-prompt.js";
import { createTurnUsage } from "./server/turn-usage.js";
import { createUsageFeed, openUsageFeed, type FeedApi } from "./server/usage-feed.js";
import { foldIndexRpc } from "./shared/fold-index.js";
import { turnPromptRpc } from "./shared/prompt-pin.js";
import { readImageRpc } from "./shared/read-image.js";
import { TurnTimePublisher } from "./server/turn-time.js";
import { activitySettings } from "./shared/settings";

type ServerApi = Parameters<Parameters<PluginServerContext["handle"]>[1]>[1]["paseo"];

export default function contribute(server: PluginServerContext) {
  const locales = createLocaleService(server, { pluginId: "vivid-activity", builtins: BUILTIN_CATALOGS });
  // 0.8.0: turn tokens (server/turn-usage.ts). The plugin server's API comes with each hook and handler call.
  let api: ServerApi | null = null;
  const see = (paseo: ServerApi | undefined) => {
    if (paseo) api = paseo;
  };
  const feed = createUsageFeed({
    open: (events) => (api ? openUsageFeed(api as unknown as FeedApi, events) : null),
    onUpdate: (payload) => usage.feedUpdate(payload),
    onGap: () => usage.feedGap(),
  });
  const usage = createTurnUsage({
    base: createProviderBases(),
    refresh: async (agentId) => {
      const result = api ? await api.agents.ref(agentId).refresh() : null;
      return (result?.agent as { lastUsage?: unknown } | undefined) ?? null;
    },
    feed,
    turnName: (agentId, turnId) => turnName(agentId, turnId),
  });
  server.handle(getClientChunk, getUiChunk);
  const settings = server.registerSettings(activitySettings);
  const turnTimes = new TurnTimePublisher(settings);
  turnTimes.start();
  server.handle(childSummaryRpc, handleChildSummary);
  server.handle(readImageRpc, (input, context) => handleReadImage(input, context));
  // 本地补丁：折叠用的时间线索引（只回传位置、种类、状态和类别）。0.8.0：另带改动行数、退出码和本轮 Token。
  server.handle(foldIndexRpc, (input, context) => {
    see(context.paseo);
    return handleFoldIndex(input, context, usage);
  });
  // 0.6.0：钉在最新一段活动上方的提问（只回传那条用户消息的文字）。
  server.handle(turnPromptRpc, (input, context) => handleTurnPrompt(input, context));
  // 本地补丁（0.3.0-local.3）：记下每一轮的开始，计时不再跨轮（自主轮没有用户消息可作开始）。0.8.0：本轮 Token 也从这里起算。
  const stopTurns = server.on("agent.turn_started", (event, context) => {
    see(context?.paseo);
    noteTurnStarted(event.agent.id, event.turnId);
    turnTimes.started(event.agent.id);
    void usage.turnStarted(event.agent.id, event.agent.provider, event.turnId).catch(() => undefined);
  });
  const stopEnded = server.on("agent.turn_ended", (event, context) => {
    see(context?.paseo);
    usage.turnEnded(event.agent.id, event.turnId);
    return turnTimes.finish(event, context);
  });
  // 0.5.0：Agent 关闭（归档、删除、从归档恢复、daemon 停止）后丢掉它的轮次开始时间（Paseo 0.11 的 `agent.closed`）。
  // 0.10.0-local.3：Paseo 0.14 在空闲一小时后也关闭会话，下次发消息再载入；关闭只换一代（之前的轮次还要显示用时和 Token，
  // 下一个会话重名的轮次换个名字），归档时才丢掉。
  const stopClosed = server.on("agent.closed", (event) => {
    noteAgentClosed(event.agent.id);
    usage.closed(event.agent.id);
  });
  const stopArchived = server.on("agent.archived", (event) => {
    forgetAgentTurns(event.agent.id);
    usage.forget(event.agent.id);
    turnTimes.forget(event.agent.id);
  });
  return () => {
    locales.dispose();
    stopTurns();
    stopEnded();
    turnTimes.dispose();
    stopClosed();
    stopArchived();
    usage.dispose();
    feed.dispose();
  };
}
