import type { PluginHandlerContext, PluginLifecycleEvents, PluginSettings } from "@getpaseo/plugin/server";
import { activitySettings, turnTimeFromValues } from "../shared/settings";
import { TURN_TIME_RENDERER_KIND, TURN_TIME_RENDERER_VERSION, turnTimeDataSchema } from "../shared/turn-time";

type Settings = PluginSettings<typeof activitySettings.schema>;
type Paseo = PluginHandlerContext["paseo"];

/**
 * 本地补丁：每一轮结束时，追加一行这一轮的结束时刻。
 *
 * daemon 的时间线写入只有 append（`agent.timeline.append.request`），**没有按位置插入、也没有绑定轮次的接口**，一行落在
 * 哪里由宿主提交的先后决定。钩子在整轮结束时触发，通常写下的行就在这一轮所有内容之后；但 lifecycle 事件是 best effort，
 * 回调彼此可以重叠、完成顺序不保证（Paseo v0.11.1 plugins reference），`server.on` 返回的 Promise 也不会让下一轮等它。
 * 所以这一行**不保证**紧贴这一轮末尾：
 *
 * - 时刻取钩子触发的那一刻（进入 `finish` 时），之后等设置、等写入都不会把时间拖后。
 * - 等设置期间这个 Agent 已经开始了下一轮：此时再写，行会落进下一轮的内容里，于是不写（宁缺不错）。
 * - 写入请求已经发出、宿主却先提交了下一轮的内容：插件无从避免，这一行可能出现在下一轮开头几行之后。行里带着
 *   turnId；折叠索引（shared/fold-index.ts）完全不收这种行，所以无论它落在哪里，都不会切断下一轮的折叠、也不影响计时。
 */
export class TurnTimePublisher {
  private readonly settings: Settings;
  /** null until the stored switch is known; a write always waits for it. */
  private enabled: boolean | null = null;
  private ready: Promise<void> = Promise.resolve();
  private stopSettings: (() => void) | null = null;
  private stopped = false;
  /** A change notification is at least as new as the first read: a read that answers after one must not undo it. */
  private notified = false;
  /** Per agent: a number that changes whenever one of its turns starts (`started`). */
  private readonly starts = new Map<string, number>();
  private startCount = 0;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  /** Reads the switch once and follows later changes. */
  start(): void {
    this.ready = this.settings
      .read()
      .then((state) => {
        if (!this.stopped && !this.notified) this.enabled = state.status === "ready" && turnTimeFromValues(state.values);
      })
      .catch(() => undefined);
    try {
      this.stopSettings = this.settings.subscribe((state) => {
        this.notified = true;
        this.enabled = state.status === "ready" && turnTimeFromValues(state.values);
      });
    } catch {
      this.stopSettings = null;
    }
  }

  dispose(): void {
    this.stopped = true;
    this.stopSettings?.();
    this.stopSettings = null;
  }

  /** A turn of the agent began (`agent.turn_started`): an earlier turn's row not written yet would land inside it. */
  started(agentId: string): void {
    this.starts.set(agentId, ++this.startCount);
  }

  /** The agent was archived: nothing is written for it any more. */
  forget(agentId: string): void {
    this.starts.delete(agentId);
  }

  /** One row for a finished turn, carrying the moment it ended. */
  async finish(event: PluginLifecycleEvents["agent.turn_ended"], context: PluginHandlerContext): Promise<void> {
    const at = Date.now();
    const agentId = event.agent.id;
    const startsBefore = this.starts.get(agentId);
    await this.ready;
    if (!this.enabled || this.stopped) return;
    // The agent began another turn meanwhile: written now, the row would sit among that turn's rows.
    if (this.starts.get(agentId) !== startsBefore) return;
    const data = turnTimeDataSchema.parse({ at, turnId: event.turnId, outcome: event.outcome.kind });
    await this.append(context.paseo, agentId, `${event.turnId ?? "turn"}-end-${at}`, data);
  }

  private async append(
    paseo: Paseo,
    agentId: string,
    id: string,
    data: ReturnType<typeof turnTimeDataSchema.parse>,
  ): Promise<void> {
    try {
      await paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id,
        kind: TURN_TIME_RENDERER_KIND,
        version: TURN_TIME_RENDERER_VERSION,
        data,
      });
    } catch (error) {
      // 未加载的 Agent（例如子 Agent 自己的会话）读不到时间线：静默跳过，不刷日志。
      const message = error instanceof Error ? error.message : String(error);
      if (!/unknown agent|not found/i.test(message)) {
        console.error("vivid-activity: turn time row unavailable", agentId, error);
      }
    }
  }
}
