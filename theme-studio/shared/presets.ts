import type { ThemeStudioPreset } from "./theme-types.js";

export const TAILWIND_PROMPT_EXAMPLE = `(tailwind style)
{
  'ink_black': { DEFAULT: '#000814', 100: '#000204', 200: '#000308', 300: '#00050c', 400: '#000710', 500: '#000814', 600: '#002f76', 700: '#0056d8', 800: '#3b89ff', 900: '#9dc4ff' },
  'prussian_blue': { DEFAULT: '#001d3d', 100: '#00060c', 200: '#000c18', 300: '#001225', 400: '#001831', 500: '#001d3d', 600: '#004997', 700: '#0074f1', 800: '#4ba2ff', 900: '#a5d1ff' },
  'regal_navy': { DEFAULT: '#003566', 100: '#000b14', 200: '#001529', 300: '#00203d', 400: '#002a52', 500: '#003566', 600: '#005fb8', 700: '#0a89ff', 800: '#5cb0ff', 900: '#add8ff' },
  'school_bus_yellow': { DEFAULT: '#ffc300', 100: '#332700', 200: '#664e00', 300: '#997500', 400: '#cc9c00', 500: '#ffc300', 600: '#ffcf33', 700: '#ffdb66', 800: '#ffe799', 900: '#fff3cc' },
  'gold': { DEFAULT: '#ffd60a', 100: '#352c00', 200: '#6a5800', 300: '#9f8500', 400: '#d4b100', 500: '#ffd60a', 600: '#ffde3b', 700: '#ffe76c', 800: '#ffef9d', 900: '#fff7ce' }
}`;

export const CSS_PROMPT_EXAMPLE = `(CSS style)
--ink-black: #000814ff;
--prussian-blue: #001d3dff;
--regal-navy: #003566ff;
--school-bus-yellow: #ffc300ff;
--gold: #ffd60aff;`;

export const BUILTIN_PRESETS: ThemeStudioPreset[] = [
  {
    id: "navy-gold",
    name: "Deep Navy & Gold",
    appearance: "dark",
    tokens: {
      background: "#000814",
      raised: "#001d3d",
      control: "#003566",
      border: "#002a52",
      ring: "#005fb8",
      foreground: "#add8ff",
      mutedForeground: "#5cb0ff",
      accent: "#ffc300",
    },
    rawInput: TAILWIND_PROMPT_EXAMPLE,
  },
  {
    id: "emerald-night",
    name: "Emerald Night",
    appearance: "dark",
    tokens: {
      background: "#051512",
      raised: "#0a2620",
      control: "#0f3830",
      border: "#175246",
      ring: "#10b981",
      foreground: "#e6fbf5",
      mutedForeground: "#6ee7b7",
      accent: "#34d399",
    },
    rawInput: `(tailwind style)
{
  'emerald_dark': { DEFAULT: '#051512', 100: '#020907', 200: '#051512', 300: '#0a2620', 400: '#0f3830', 500: '#175246', 600: '#059669', 700: '#10b981', 800: '#34d399', 900: '#e6fbf5' }
}`,
  },
  {
    id: "tokyo-cyber",
    name: "Tokyo Cyber",
    appearance: "dark",
    tokens: {
      background: "#0d0f18",
      raised: "#161927",
      control: "#202538",
      border: "#2c334d",
      ring: "#8b5cf6",
      foreground: "#f3f4f6",
      mutedForeground: "#a5b4fc",
      accent: "#ec4899",
    },
    rawInput: `(CSS style)
--bg-cyber: #0d0f18;
--raised-cyber: #161927;
--control-cyber: #202538;
--border-cyber: #2c334d;
--neon-pink: #ec4899;
--neon-violet: #8b5cf6;
--text-glow: #f3f4f6;`,
  },
  {
    id: "clean-slate",
    name: "Clean Slate",
    appearance: "light",
    tokens: {
      background: "#f8fafc",
      raised: "#ffffff",
      control: "#f1f5f9",
      border: "#cbd5e1",
      ring: "#0284c7",
      foreground: "#0f172a",
      mutedForeground: "#64748b",
      accent: "#0284c7",
    },
    rawInput: `(CSS style)
--slate-bg: #f8fafc;
--slate-card: #ffffff;
--slate-control: #f1f5f9;
--slate-border: #cbd5e1;
--slate-primary: #0284c7;
--slate-text: #0f172a;
--slate-muted: #64748b;`,
  },
];
