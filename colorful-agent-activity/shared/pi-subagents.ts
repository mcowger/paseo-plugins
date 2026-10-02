import { compactText, extractPiToolText, normalizePiToolName } from "./presentation";

export function piSubagentOperation(name: string): "dispatch" | "result" | "steer" | undefined {
  switch (normalizePiToolName(name)) {
    case "agent": return "dispatch";
    case "get_subagent_result": return "result";
    case "steer_subagent": return "steer";
    default: return undefined;
  }
}

export function parsePiSubagentCall(input: unknown, output: unknown) {
  let value = input;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = undefined; }
  }
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const envelope = extractPiToolText(output);
  const text = envelope?.text ?? "";
  const lifecycleText = text.replace(/^Note: run_in_background[^\r\n]*\r?\n\s*\r?\n/, "");
  const header = lifecycleText.split(/\r?\n\s*\r?\n/)[0] ?? "";
  const details = envelope?.details ?? {};
  const detailField = (key: string) => typeof details[key] === "string" ? details[key].trim() || undefined : undefined;
  const field = (key: string) => typeof record[key] === "string" && record[key].trim()
    ? record[key].trim() : undefined;
  const recognizedHeader = /^(?:Agent(?: started| queued) in background\.|Agent:|Steering message sent to agent |Agent "|Agent not found:)/.test(header);
  const line = (label: string) => recognizedHeader ? header.match(new RegExp(`^${label}:[^\\S\\r\\n]*([^\\r\\n]+)`, "m"))?.[1]?.trim() || undefined : undefined;
  const operationValue = line("Operation") ?? detailField("operation");
  const operation = operationValue === "wait" || operationValue === "result" || operationValue === "steer"
    ? operationValue : undefined;
  const description = field("description") ?? detailField("description") ?? line("Description");
  const agentId = field("agent_id") ?? detailField("agentId") ?? line("Agent ID") ?? line("Agent")
    ?? header.match(/^Steering message sent to agent ([^\s.]+)\./)?.[1]
    ?? header.match(/^Agent(?: not found:)? "([^"]+)"/)?.[1];
  const agentType = field("subagent_type") ?? detailField("subagentType") ?? line("Type")?.split(" | ")[0];
  const queued = header.startsWith("Agent queued in background.");
  const dispatch = queued || header.startsWith("Agent started in background.");
  const result = header.startsWith("Agent:");
  const steering = header.startsWith("Steering message sent to agent ");
  const responseBody = result ? lifecycleText.slice(header.length).trim() : lifecycleText;
  const rejected = responseBody.match(/^Agent "[^"]+" is not running \(status: ([^)]+)\)\.\s*(.*)/);
  const missing = header.startsWith("Agent not found:");
  const lifecycle = dispatch || result || steering || !!rejected || missing || operation !== undefined;
  const status = header.match(/^Type:[^\r\n]*\| Status:\s*([a-z]+)/m)?.[1]
    ?? rejected?.[1] ?? detailField("status") ?? (queued ? "queued" : dispatch ? "background" : undefined);
  let body = dispatch || steering || rejected || missing ? ""
    : result ? responseBody : text;
  const errorMatch = result && status === "error" ? body.match(/^Error:\s*([\s\S]*)$/) : undefined;
  const error = rejected?.[2] ?? (missing ? "Agent not found. It may have been cleaned up." : undefined)
    ?? errorMatch?.[1];
  if (errorMatch && error) body = "";
  const toolUsesMatch = header.match(/(?:^|\| )Tool uses:\s*(\d+)/m);
  const toolUses = toolUsesMatch ? Number(toolUsesMatch[1])
    : typeof details.toolUses === "number" ? details.toolUses : undefined;
  const tokens = header.match(/\|\s*([\d.]+[kM]?) tokens?\b/)?.[1] ?? detailField("tokens");
  const context = header.match(/\| Context:\s*([\d.]+%)/)?.[1];
  const duration = header.match(/\| Duration:\s*([^|\r\n]+)/)?.[1]?.trim();
  const outputFile = line("Output file");
  const notice = steering || (operation === "steer" && responseBody.startsWith("Steering message sent to agent "))
    ? "Steering message sent. It will be processed after the current tool execution."
    : body === "Agent is still running. Use wait: true or check back later." ? "Agent is still running." : undefined;
  if (notice) body = "";
  return { agentId, agentType, description, status, prompt: field("prompt"),
    message: field("message"), operation,
    wait: operation === "wait" ? true : operation === "result" ? false : typeof record.wait === "boolean" ? record.wait : undefined,
    text, body, lifecycle, error, notice, toolUses, tokens, context, duration, outputFile };
}

export function piSubagentPresentation(name: string, input: unknown, output: unknown, description?: string, agentType?: string) {
  const operation = piSubagentOperation(name);
  const parsed = parsePiSubagentCall(input, output);
  const label = operation === "dispatch" ? "Dispatch Agent"
    : operation === "steer" ? "Steer Agent"
    : parsed.wait === true ? "Wait for Agent"
    : parsed.wait === false ? "Check Agent Result" : "Agent Result";
  const icon = operation === "dispatch" ? "Bot" : operation === "steer" ? "MessageCircle" : "Hourglass";
  const subject = parsed.description ?? description ?? (operation === "dispatch" ? agentType ?? parsed.agentType : parsed.agentId ?? parsed.agentType);
  const type = parsed.operation ? parsed.agentType ?? agentType : undefined;
  const summary = [type && type !== subject ? compactText(type) : undefined,
    subject ? compactText(subject, 120) : undefined, parsed.status].filter(Boolean).join(" · ") || undefined;
  return { category: "agent" as const, icon, label, summary };
}
