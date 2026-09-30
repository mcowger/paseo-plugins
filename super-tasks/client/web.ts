import { Platform } from "react-native";

/**
 * The Paseo web shell listens for this event and opens the matching agent. The
 * name is a host contract, not a private detail.
 */
const AGENT_OPEN_EVENT = "paseo:web-notification-click";

interface WebCustomEventInit<Detail> {
  detail?: Detail;
  cancelable?: boolean;
}

interface WebCustomEvent<Detail> {
  readonly detail: Detail;
}

type WebCustomEventConstructor = new <Detail>(
  type: string,
  eventInitDict?: WebCustomEventInit<Detail>,
) => WebCustomEvent<Detail>;

interface WebGlobals {
  CustomEvent?: WebCustomEventConstructor;
  dispatchEvent?: (event: unknown) => boolean;
  location?: { assign?: (url: string) => void; href?: string };
}

function readWebGlobals(): WebGlobals | null {
  if (Platform.OS !== "web") return null;
  return globalThis as unknown as WebGlobals;
}

/** The in-app route for one agent, shared by web dispatch and the native deep link. */
export function buildAgentRoute(input: {
  serverId: string;
  workspaceId: string;
  agentId: string;
}): string {
  const serverId = encodeURIComponent(input.serverId);
  const workspaceId = encodeURIComponent(input.workspaceId);
  const open = encodeURIComponent(`agent:${input.agentId}`);
  return `/h/${serverId}/workspace/${workspaceId}?open=${open}`;
}

/**
 * Web-only. Dispatches the shell's open-agent event, falling back to a location
 * change. Returns `true` once the request is handed to the host. Native callers
 * must not reach this; they use the deep link in `navigation.ts` instead.
 */
export function dispatchOpenAgentRequest(input: {
  serverId: string;
  workspaceId: string;
  agentId: string;
}): boolean {
  const globals = readWebGlobals();
  if (!globals) return false;

  const CustomEventConstructor = globals.CustomEvent;
  const dispatch = globals.dispatchEvent;
  if (typeof dispatch === "function" && CustomEventConstructor) {
    try {
      const event = new CustomEventConstructor(AGENT_OPEN_EVENT, {
        detail: { data: { ...input } },
        cancelable: true,
      });
      // A listener that calls preventDefault claims the event; we are done.
      if (!dispatch(event)) return true;
    } catch {
      // Fall through to the location change.
    }
  }

  const location = globals.location;
  if (!location) return false;
  try {
    const route = buildAgentRoute(input);
    if (typeof location.assign === "function") location.assign(route);
    else location.href = route;
    return true;
  } catch {
    return false;
  }
}
