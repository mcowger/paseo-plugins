function displayTier(tier: string): string {
  return tier === "default" || tier === "auto" || tier === "standard" ? "default" : tier;
}

/** Group default aliases in the UI without changing the control's advertised tiers. */
export function tierSettingPresentation(
  choices: readonly string[],
  selected: string,
): {
  value: string | null;
  options: Array<{ label: string; value: string }>;
} {
  const values = [...new Set(choices.map(displayTier))];
  return {
    value: choices.includes(selected) ? displayTier(selected) : null,
    options: values.map((value) => ({ label: value, value })),
  };
}
