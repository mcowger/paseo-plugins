import { useAgent, useSettings } from "@getpaseo/plugin/client";
import { useEffect } from "react";
import type { StepStatus } from "../shared/fold";
import { activitySettings, DEFAULT_DENSITY, type Density } from "../shared/settings";
import { foldRuntime } from "./fold-runtime";

export { densityMetrics, STREAM_ROW_GAP, type DensityMetrics } from "../shared/density";

export function useDensity(): Density {
  const settings = useSettings(activitySettings);
  return settings.status === "ready" ? settings.values.density : DEFAULT_DENSITY;
}

/**
 * Keeps the agent's fold index alive while one of its rows is on screen, feeds it the Agent's running state, and tells it
 * about this row (a new row or a changed state makes it read the timeline again).
 */
export function useFoldRow(agentId: string, key: string | undefined, status: StepStatus | undefined, timestamp: Date): void {
  const running = useAgent(agentId, (agent) => agent.status === "running");
  useEffect(() => {
    foldRuntime.acquire(agentId);
    return () => foldRuntime.release(agentId);
  }, [agentId]);
  useEffect(() => {
    if (running !== null) foldRuntime.setRunning(agentId, running);
  }, [agentId, running]);
  const at = timestamp.getTime();
  useEffect(() => {
    if (key) foldRuntime.noteRow(agentId, key, status, at);
  }, [agentId, key, status, at]);
}
