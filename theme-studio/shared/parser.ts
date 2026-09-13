import type {
  ExtractedPalette,
  ParsedColor,
  ThemeAppearance,
  ThemeStudioTokens,
} from "./theme-types.js";

const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function normalizeHex(raw: string): string | null {
  const trimmed = raw.trim();
  if (!HEX_COLOR_REGEX.test(trimmed)) return null;

  const hexBody = trimmed.slice(1);
  if (hexBody.length === 3) {
    const [r, g, b] = hexBody;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (hexBody.length === 6) {
    return `#${hexBody.toLowerCase()}`;
  }
  if (hexBody.length === 8) {
    const rgb = hexBody.slice(0, 6).toLowerCase();
    return `#${rgb}`;
  }
  return null;
}

export function getLuminance(hex: string): number {
  const normalized = normalizeHex(hex);
  if (!normalized) return 0.5;

  const r = Number.parseInt(normalized.slice(1, 3), 16) / 255;
  const g = Number.parseInt(normalized.slice(3, 5), 16) / 255;
  const b = Number.parseInt(normalized.slice(5, 7), 16) / 255;

  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function getSaturation(hex: string): number {
  const normalized = normalizeHex(hex);
  if (!normalized) return 0;

  const r = Number.parseInt(normalized.slice(1, 3), 16) / 255;
  const g = Number.parseInt(normalized.slice(3, 5), 16) / 255;
  const b = Number.parseInt(normalized.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  if (max === 0) return 0;
  return delta / max;
}

function parseTailwindBlock(text: string): ParsedColor[] {
  const results: ParsedColor[] = [];
  const groupRegex = /['"]?([a-zA-Z0-9_-]+)['"]?\s*:\s*\{([^}]+)\}/g;
  let groupMatch: RegExpExecArray | null;

  while ((groupMatch = groupRegex.exec(text)) !== null) {
    const groupName = groupMatch[1];
    const blockBody = groupMatch[2];
    const shadeRegex = /['"]?([a-zA-Z0-9_]+)['"]?\s*:\s*['"](#[0-9a-fA-F]{3,8})['"]/g;
    let shadeMatch: RegExpExecArray | null;

    while ((shadeMatch = shadeRegex.exec(blockBody)) !== null) {
      const shade = shadeMatch[1];
      const rawHex = shadeMatch[2];
      const hex = normalizeHex(rawHex);
      if (hex) {
        const id = `${groupName}.${shade}`;
        results.push({
          id,
          name: `${groupName} ${shade}`,
          group: groupName,
          shade,
          hex,
          luminance: getLuminance(hex),
        });
      }
    }
  }
  return results;
}

function parseCssVariables(text: string): ParsedColor[] {
  const results: ParsedColor[] = [];
  const varRegex = /(--[a-zA-Z0-9_-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g;
  let match: RegExpExecArray | null;

  while ((match = varRegex.exec(text)) !== null) {
    const varName = match[1];
    const rawHex = match[2];
    const hex = normalizeHex(rawHex);
    if (hex) {
      // Determine group: e.g. --ink-black -> "ink-black"
      const cleanName = varName.replace(/^--/, "");
      results.push({
        id: varName,
        name: varName,
        group: "CSS Variables",
        shade: cleanName,
        hex,
        luminance: getLuminance(hex),
      });
    }
  }
  return results;
}

function parseJsonPalette(text: string): ParsedColor[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }

  const results: ParsedColor[] = [];
  const seen = new Set<unknown>();
  const visit = (current: unknown, path: string[], depth: number): void => {
    if (depth > 8 || current === null || typeof current !== "object" || seen.has(current)) {
      return;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, [...path, String(index)], depth + 1));
      return;
    }
    for (const [key, item] of Object.entries(current)) {
      if (typeof item === "string") {
        const hex = normalizeHex(item);
        if (hex) {
          const itemPath = [...path, key];
          results.push({
            id: itemPath.join("."),
            name: itemPath.join(" · "),
            group: path[0] ?? "JSON",
            hex,
            luminance: getLuminance(hex),
          });
        }
      } else {
        visit(item, [...path, key], depth + 1);
      }
    }
  };
  visit(value, [], 0);
  return results;
}

function parseFlatHexEntries(text: string): ParsedColor[] {
  const results: ParsedColor[] = [];
  const hexRegex = /#([0-9a-fA-F]{3,8})\b/g;
  let match: RegExpExecArray | null;
  let index = 1;

  while ((match = hexRegex.exec(text)) !== null) {
    const hex = normalizeHex(`#${match[1]}`);
    if (hex) {
      const id = `color-${index}`;
      results.push({
        id,
        name: `Color ${index}`,
        group: "Custom",
        hex,
        luminance: getLuminance(hex),
      });
      index++;
    }
  }
  return results;
}

export function extractPalette(input: string): ExtractedPalette {
  const text = input.trim();
  if (!text) {
    return { colors: [], format: "empty", groups: [] };
  }

  // Check JSON before the looser object and CSS formats.
  const jsonColors = parseJsonPalette(text);
  if (jsonColors.length > 0) {
    const groups = [...new Set(jsonColors.map((c) => c.group))];
    return { colors: jsonColors, format: "json", groups };
  }

  // Check Tailwind nested object format next.
  const tailwindColors = parseTailwindBlock(text);
  if (tailwindColors.length > 0) {
    const groups = [...new Set(tailwindColors.map((c) => c.group))];
    return { colors: tailwindColors, format: "tailwind", groups };
  }

  // Check CSS custom properties
  const cssColors = parseCssVariables(text);
  if (cssColors.length > 0) {
    const groups = [...new Set(cssColors.map((c) => c.group))];
    return { colors: cssColors, format: "css", groups };
  }

  // Fallback to loose hex occurrences
  const hexColors = parseFlatHexEntries(text);
  const groups = [...new Set(hexColors.map((c) => c.group))];
  return {
    colors: hexColors,
    format: hexColors.length > 0 ? "hex-list" : "empty",
    groups,
  };
}

export function autoMapTokens(
  colors: ParsedColor[],
  appearance: ThemeAppearance = "dark",
): ThemeStudioTokens {
  if (colors.length === 0) {
    return appearance === "dark"
      ? {
          background: "#000814",
          foreground: "#add8ff",
          raised: "#001d3d",
          control: "#003566",
          border: "#002a52",
          ring: "#005fb8",
          mutedForeground: "#5cb0ff",
          accent: "#ffc300",
        }
      : {
          background: "#ffffff",
          foreground: "#000814",
          raised: "#f0f4f8",
          control: "#e2e8f0",
          border: "#cbd5e1",
          ring: "#0056d8",
          mutedForeground: "#475569",
          accent: "#0056d8",
        };
  }

  // Find most vibrant / saturated color for accent
  const withSaturation = [...colors].sort(
    (a, b) => getSaturation(b.hex) - getSaturation(a.hex) || b.luminance - a.luminance,
  );
  const accentCandidate = withSaturation[0];

  if (appearance === "dark") {
    // Sort darkest to brightest
    const sorted = [...colors].sort((a, b) => a.luminance - b.luminance);
    const n = sorted.length;

    const background = sorted[0].hex;
    const raised = sorted[Math.min(1, n - 1)].hex;
    const control = sorted[Math.min(2, n - 1)].hex;
    const border = sorted[Math.min(3, n - 1)].hex;
    const ring = sorted[Math.min(4, n - 1)].hex;
    const foreground = sorted[n - 1].hex;
    const mutedForeground = sorted[Math.max(0, n - 2)].hex;
    const accent = accentCandidate ? accentCandidate.hex : sorted[n - 1].hex;

    return {
      background,
      foreground,
      raised,
      control,
      border,
      ring,
      mutedForeground,
      accent,
    };
  }

  // Light mode: sort brightest to darkest
  const sorted = [...colors].sort((a, b) => b.luminance - a.luminance);
  const n = sorted.length;

  const background = sorted[0].hex;
  const raised = sorted[Math.min(1, n - 1)].hex;
  const control = sorted[Math.min(2, n - 1)].hex;
  const border = sorted[Math.min(3, n - 1)].hex;
  const ring = sorted[Math.min(4, n - 1)].hex;
  const foreground = sorted[n - 1].hex;
  const mutedForeground = sorted[Math.max(0, n - 2)].hex;
  const accent = accentCandidate ? accentCandidate.hex : sorted[n - 1].hex;

  return {
    background,
    foreground,
    raised,
    control,
    border,
    ring,
    mutedForeground,
    accent,
  };
}

export function generatePluginCode(options: {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  tokens: ThemeStudioTokens;
}): string {
  const { id, name, appearance, tokens } = options;
  return `import type { PluginClientContext } from "@getpaseo/plugin/client";

export default function contribute(client: PluginClientContext) {
  client.addTheme({
    id: ${JSON.stringify(id)},
    name: ${JSON.stringify(name)},
    appearance: ${JSON.stringify(appearance)},
    colors: {
      background: ${JSON.stringify(tokens.background)},
      foreground: ${JSON.stringify(tokens.foreground)},
      raised: ${JSON.stringify(tokens.raised)},
      control: ${JSON.stringify(tokens.control)},
      border: ${JSON.stringify(tokens.border)},
      ring: ${JSON.stringify(tokens.ring)},
      mutedForeground: ${JSON.stringify(tokens.mutedForeground)},
      accent: ${JSON.stringify(tokens.accent)},
    },
  });
  return () => {};
}
`;
}
