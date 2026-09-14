import type { ProviderMode } from "@getpaseo/plugin/server/provider";

export const PI_COMPATIBILITY_MODES: readonly ProviderMode[] = [
  {
    id: "build",
    label: "Build",
    description: "Compatibility mode; Pi does not apply Paseo mode settings.",
  },
];
