export type ServiceTier = "default" | "priority" | "flex" | "ultrafast";

export interface ServiceTierOption {
  readonly id: ServiceTier;
  /** Label shown on the pill and in the picker. */
  readonly label: string;
  readonly description: string;
  /** Argument sent to the pi `/service-tier` command. */
  readonly commandArg: string;
}

export const SERVICE_TIER_OPTIONS: readonly ServiceTierOption[] = [
  {
    id: "default",
    label: "Default",
    description: "Standard processing and pricing.",
    commandArg: "default",
  },
  {
    id: "priority",
    label: "Fast",
    description: "Lower-latency processing at premium pricing.",
    commandArg: "fast",
  },
  {
    id: "flex",
    label: "Flex",
    description: "Lower cost, slower, and may hit capacity limits.",
    commandArg: "flex",
  },
  {
    id: "ultrafast",
    label: "Ultrafast",
    description: "Fastest tier; limited to eligible GPT-6 and GPT-5.6 models.",
    commandArg: "ultrafast",
  },
];

const OPTION_BY_ID = new Map<ServiceTier, ServiceTierOption>(
  SERVICE_TIER_OPTIONS.map((option) => [option.id, option]),
);

export function serviceTierLabel(tier: ServiceTier): string {
  return OPTION_BY_ID.get(tier)?.label ?? "Default";
}

export const PASEO_PI_PROVIDER = "pi";
export const PLEXUS_MODEL_PREFIX = "plexus/";
export const SERVICE_TIER_COMMAND = "service-tier";

// Kept in step with plexus-pi's matcher: GPT 5.5 and newer, including dotted
// (gpt-5.10, gpt-6.1-sol) and suffixed (gpt-5.6-luna) lines.
const SUPPORTED_MODEL_SLUG = /^gpt-(?:5\.(?:[5-9]|\d{2,})|[6-9]\d*(?:\.\d+)?)(?:[-_.]|$)/i;
// Ultrafast: broad on GPT-6 Astra, preview on GPT-5.6 Sol (ultrafast-mode guide).
const ULTRAFAST_MODEL_SLUG = /^gpt-6(?:\.\d+)?-astra(?:$|[-_.])|^gpt-5\.6-sol(?:$|[-_.])/i;
// Claude Fast mode (research preview): Claude Opus 5.5, Opus 5, and Opus 4.8.
// Opus 4.7 hard-errors and Opus 4.6 silently runs standard (choosing-a-model doc).
const CLAUDE_FAST_MODEL_SLUG = /^claude-opus-(?:5|4[-.]8)(?:$|[-_.])/i;

/** The pi model id stripped of its `plexus/` prefix, or null when not Plexus. */
export function plexusModelSlug(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  if (!trimmed.toLowerCase().startsWith(PLEXUS_MODEL_PREFIX)) return null;
  const slug = trimmed.slice(PLEXUS_MODEL_PREFIX.length).trim();
  return slug.length > 0 ? slug : null;
}

/** Model family with selectable Plexus service tiers. */
export type ServiceTierFamily = "gpt" | "claude";

/** True for a Paseo `pi` agent running a Plexus model with selectable tiers. */
export function isServiceTierAgent(
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  if (provider !== PASEO_PI_PROVIDER) return false;
  const slug = plexusModelSlug(model);
  return slug !== null && modelFamily(slug) !== null;
}

/** Classifies a Plexus model slug into a tier-capable family, or null. */
export function modelFamily(slug: string): ServiceTierFamily | null {
  if (SUPPORTED_MODEL_SLUG.test(slug)) return "gpt";
  if (CLAUDE_FAST_MODEL_SLUG.test(slug)) return "claude";
  return null;
}

/**
 * Tiers selectable for this agent's current model, in menu order.
 *
 * GPT: Fast/Flex on every GPT-5.5+ Responses model in scope (the GPT-6
 * flagship pages all price Flex, and gpt-5.5/gpt-5.6 are shown with Flex),
 * plus Ultrafast on GPT-6 Astra and GPT-5.6 Sol.
 * Claude: Default and Fast only, and only on the Fast-mode Opus models.
 */
export function availableTiers(
  provider: string | null | undefined,
  model: string | null | undefined,
): ServiceTier[] {
  if (provider !== PASEO_PI_PROVIDER) return [];
  const slug = plexusModelSlug(model);
  if (slug === null) return [];
  if (SUPPORTED_MODEL_SLUG.test(slug)) {
    return ULTRAFAST_MODEL_SLUG.test(slug)
      ? ["default", "priority", "flex", "ultrafast"]
      : ["default", "priority", "flex"];
  }
  if (CLAUDE_FAST_MODEL_SLUG.test(slug)) return ["default", "priority"];
  return [];
}

/** True when `tier` can be selected for this agent's current model. */
export function isTierAvailable(
  provider: string | null | undefined,
  model: string | null | undefined,
  tier: ServiceTier,
): boolean {
  return availableTiers(provider, model).includes(tier);
}

/** The option descriptors to render, in menu order. */
export function serviceTierOptions(
  provider: string | null | undefined,
  model: string | null | undefined,
): ServiceTierOption[] {
  const available = new Set(availableTiers(provider, model));
  return SERVICE_TIER_OPTIONS.filter((option) => available.has(option.id));
}

/** The pi slash command that selects `tier`. */
export function serviceTierInvocation(tier: ServiceTier): string {
  const option = OPTION_BY_ID.get(tier);
  if (!option) throw new Error(`Unknown service tier: ${tier}`);
  return `/${SERVICE_TIER_COMMAND} ${option.commandArg}`;
}

/** True when the live agent session exposes the plexus-pi tier command. */
export function hasServiceTierCommand(
  commands: readonly { name?: string }[] | null | undefined,
): boolean {
  if (!Array.isArray(commands)) return false;
  return commands.some((command) => command?.name === SERVICE_TIER_COMMAND);
}
