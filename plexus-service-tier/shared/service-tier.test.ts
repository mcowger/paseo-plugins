import { describe, expect, it } from "vitest";
import {
  availableTiers,
  hasServiceTierCommand,
  isServiceTierAgent,
  isTierAvailable,
  modelFamily,
  plexusModelSlug,
  serviceTierInvocation,
  serviceTierLabel,
  serviceTierOptions,
} from "./service-tier";

describe("plexusModelSlug", () => {
  it("strips the plexus/ prefix case-insensitively", () => {
    expect(plexusModelSlug("plexus/gpt-6-luna")).toBe("gpt-6-luna");
    expect(plexusModelSlug("Plexus/gpt-5.5")).toBe("gpt-5.5");
  });

  it("rejects non-plexus and empty model ids", () => {
    expect(plexusModelSlug("openai/gpt-6-luna")).toBeNull();
    expect(plexusModelSlug("plexus/")).toBeNull();
    expect(plexusModelSlug(null)).toBeNull();
    expect(plexusModelSlug(undefined)).toBeNull();
  });
});

describe("isServiceTierAgent", () => {
  it("requires the pi provider and a plexus GPT 5.5+ model", () => {
    expect(isServiceTierAgent("pi", "plexus/gpt-5.5")).toBe(true);
    expect(isServiceTierAgent("pi", "plexus/gpt-5.6-luna")).toBe(true);
    expect(isServiceTierAgent("pi", "plexus/gpt-6-astra")).toBe(true);
    expect(isServiceTierAgent("pi", "plexus/gpt-6.1-sol")).toBe(true);
  });

  it("excludes older GPT lines, other prefixes, and other providers", () => {
    expect(isServiceTierAgent("pi", "plexus/gpt-5.4")).toBe(false);
    expect(isServiceTierAgent("pi", "plexus/gpt-5-codex")).toBe(false);
    expect(isServiceTierAgent("pi", "openai/gpt-6-luna")).toBe(false);
    expect(isServiceTierAgent("codex", "plexus/gpt-6-luna")).toBe(false);
  });

  it("accepts the Claude Fast-mode Opus models only", () => {
    expect(isServiceTierAgent("pi", "plexus/claude-opus-5-5")).toBe(true);
    expect(isServiceTierAgent("pi", "plexus/claude-opus-5")).toBe(true);
    expect(isServiceTierAgent("pi", "plexus/claude-opus-4-8")).toBe(true);
    expect(isServiceTierAgent("pi", "plexus/claude-opus-4.8")).toBe(true);
    expect(isServiceTierAgent("pi", "plexus/claude-opus-4-7")).toBe(false);
    expect(isServiceTierAgent("pi", "plexus/claude-opus-4-6")).toBe(false);
    expect(isServiceTierAgent("pi", "plexus/claude-sonnet-5")).toBe(false);
  });
});

describe("modelFamily", () => {
  it("classifies GPT and Claude slugs", () => {
    expect(modelFamily("gpt-6-luna")).toBe("gpt");
    expect(modelFamily("claude-opus-5")).toBe("claude");
    expect(modelFamily("llama-4")).toBeNull();
  });
});

describe("availableTiers", () => {
  it("lists GPT tiers in menu order", () => {
    expect(availableTiers("pi", "plexus/gpt-6-luna")).toEqual(["default", "priority", "flex"]);
    expect(availableTiers("pi", "plexus/gpt-6-astra")).toEqual([
      "default",
      "priority",
      "flex",
      "ultrafast",
    ]);
  });

  it("lists only Default and Fast for Claude Opus 5.5/5/4.8", () => {
    expect(availableTiers("pi", "plexus/claude-opus-5-5")).toEqual(["default", "priority"]);
    expect(availableTiers("pi", "plexus/claude-opus-5")).toEqual(["default", "priority"]);
    expect(availableTiers("pi", "plexus/claude-opus-4-8")).toEqual(["default", "priority"]);
    expect(availableTiers("pi", "plexus/claude-sonnet-5")).toEqual([]);
  });

  it("returns nothing for other providers or prefixes", () => {
    expect(availableTiers("codex", "plexus/gpt-6-astra")).toEqual([]);
    expect(availableTiers("pi", "openai/gpt-6-astra")).toEqual([]);
  });
});

describe("serviceTierOptions", () => {
  it("omits Flex and Ultrafast for Claude", () => {
    expect(serviceTierOptions("pi", "plexus/claude-opus-5").map((option) => option.id)).toEqual([
      "default",
      "priority",
    ]);
  });

  it("keeps the Fast label shared across families", () => {
    const claudeFast = serviceTierOptions("pi", "plexus/claude-opus-5").find(
      (option) => option.id === "priority",
    );
    expect(claudeFast?.label).toBe("Fast");
    expect(claudeFast?.commandArg).toBe("fast");
  });
});

describe("isTierAvailable", () => {
  it("offers default and fast on any eligible model", () => {
    expect(isTierAvailable("pi", "plexus/gpt-5.5", "default")).toBe(true);
    expect(isTierAvailable("pi", "plexus/gpt-5.5", "priority")).toBe(true);
  });

  it("offers flex on every GPT-5.5+ model", () => {
    expect(isTierAvailable("pi", "plexus/gpt-5.5", "flex")).toBe(true);
    expect(isTierAvailable("pi", "plexus/gpt-5.6-luna", "flex")).toBe(true);
    expect(isTierAvailable("pi", "plexus/gpt-6-astra", "flex")).toBe(true);
    expect(isTierAvailable("pi", "plexus/gpt-6-luna", "flex")).toBe(true);
    expect(isTierAvailable("pi", "plexus/gpt-6.1-sol", "flex")).toBe(true);
  });

  it("restricts ultrafast to GPT-6 Astra and GPT-5.6 Sol", () => {
    expect(isTierAvailable("pi", "plexus/gpt-6-astra", "ultrafast")).toBe(true);
    expect(isTierAvailable("pi", "plexus/gpt-6.1-astra", "ultrafast")).toBe(true);
    expect(isTierAvailable("pi", "plexus/gpt-5.6-sol", "ultrafast")).toBe(true);
    expect(isTierAvailable("pi", "plexus/gpt-6-luna", "ultrafast")).toBe(false);
    expect(isTierAvailable("pi", "plexus/gpt-5.6-luna", "ultrafast")).toBe(false);
    expect(isTierAvailable("pi", "plexus/gpt-5.5", "ultrafast")).toBe(false);
  });

  it("never offers tiers for ineligible agents", () => {
    expect(isTierAvailable("codex", "plexus/gpt-6-astra", "priority")).toBe(false);
    expect(isTierAvailable("pi", "openai/gpt-6-astra", "flex")).toBe(false);
    expect(isTierAvailable("pi", "plexus/gpt-5.4", "flex")).toBe(false);
    expect(isTierAvailable("pi", "plexus/claude-sonnet-5", "priority")).toBe(false);
    expect(isTierAvailable("pi", "plexus/claude-opus-5", "flex")).toBe(false);
  });
});

describe("serviceTierInvocation", () => {
  it("maps tiers to the plexus-pi command", () => {
    expect(serviceTierInvocation("default")).toBe("/service-tier default");
    expect(serviceTierInvocation("priority")).toBe("/service-tier fast");
    expect(serviceTierInvocation("flex")).toBe("/service-tier flex");
    expect(serviceTierInvocation("ultrafast")).toBe("/service-tier ultrafast");
  });
});

describe("serviceTierLabel", () => {
  it("labels tiers for the pill", () => {
    expect(serviceTierLabel("priority")).toBe("Fast");
    expect(serviceTierLabel("ultrafast")).toBe("Ultrafast");
  });
});

describe("hasServiceTierCommand", () => {
  it("detects the command from a live session listing", () => {
    expect(hasServiceTierCommand([{ name: "model" }, { name: "service-tier" }])).toBe(true);
  });

  it("returns false when missing or unavailable", () => {
    expect(hasServiceTierCommand([{ name: "model" }])).toBe(false);
    expect(hasServiceTierCommand(undefined)).toBe(false);
  });
});
