// Build-time-only entry: bundling pi + the MCP SDK into plain CJS eliminates
// import.meta usage that Paseo's CJS-wrapped plugin bundle cannot host.
export {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  defineTool,
} from "@earendil-works/pi-coding-agent";
export { Client } from "@modelcontextprotocol/sdk/client/index.js";
export { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
export { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
export { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
