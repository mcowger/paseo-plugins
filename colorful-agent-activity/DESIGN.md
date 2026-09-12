# Design guide

Colorful agent activity should feel like an IDE activity panel, terminal, inspector, or developer console. It is compact, technical, restrained, and content-led.

The reference is OpenChamber's activity UI. Match its design philosophy rather than copying it pixel for pixel.

## Core principle

Use the minimum visual treatment necessary to communicate structure.

Information establishes the hierarchy. Containers should not dominate the information inside them.

## Visual character

Aim for:

- Dense, readable activity streams
- Neutral near-black and charcoal surfaces
- Small, restrained monospace typography
- Muted metadata
- Small utilitarian icons
- Thin dividers and hierarchy guides
- Sparse, semantic accent color
- Subtle or square corners

Avoid:

- Large tinted backgrounds
- A separate card for every section
- Oversized headings or status areas
- Wide padding and generous vertical gaps
- Large icon badges
- Decorative pills
- Heavy borders around expanded content
- Rounded, mobile-app-style containers
- Color used as decoration

## Hierarchy

Establish hierarchy in this order:

1. Content and labels
2. Text weight and color
3. Alignment and indentation
4. Compact spacing
5. Thin guide lines or dividers
6. Background changes only when the previous options are not enough

Do not add a container just to group related content. Prefer a label, one level of indentation, or a single vertical guide.

## Activity rows

A collapsed activity item is one compact row:

```text
[icon] Label  muted summary                         status  chevron
```

Rules:

- Keep the row close to one line of text in height.
- Use a 12 px title with 17 px line height.
- Use medium or semibold weight for the action label.
- Render the summary at the same size in muted foreground color.
- Use 12 px icons without a badge or colored icon background.
- Keep horizontal gaps around 5 px and vertical padding around 2 px.
- Use at most a 2 px corner radius.
- Do not give each row a tinted background.
- Reserve category color for the icon.
- Reserve status color for the status icon or status text.

Rows should scan as a continuous activity stream, not a stack of cards.

## Expanded activity

Expansion should reveal content beneath the row without outlining it.

- Do not add a horizontal rule below the expanded header.
- Do not draw a border around the expanded region.
- Do not change the header into a colored card.
- Add one thin vertical guide to the left of the detail content.
- Indent details slightly from the header icon and label.
- Keep the detail background neutral or transparent.
- Use compact internal spacing, normally 3 to 6 px.

The vertical guide communicates ownership. No additional enclosure is needed.

## Nested activity

Nested agent work should read like a tree or IDE task panel.

- Indent each nested level consistently.
- Use a 1 px muted vertical guide for the parent-child relationship.
- Keep nested rows flat and compact.
- Do not place nested rows in separate rounded containers.
- Show several recent actions before collapsing older entries into a `+N more…` summary.
- Use stable alignment for icons, labels, summaries, and status.

Nested activity may be visually quieter than its parent, but it should remain readable at a glance.

## Typography

Monospace is the default for activity and tool detail UI.

| Role | Size | Line height | Weight |
| --- | ---: | ---: | --- |
| Activity label | 12 px | 17 px | 600 |
| Activity summary | 12 px | 17 px | 400 |
| Reasoning body | 12 px | 17 px | 400 |
| Reasoning heading | 12 px | 17 px | 600 |
| Detail text | 11 px | 16 px | 400 |
| Field value | 11 px | 15 px | 400 |
| Section label | 10 px | 14 px | 500 |
| Metadata and status | 10 px | 14 px | 400-500 |
| Code and diff text | 11 px | 16 px | 400 |

Guidelines:

- Keep headings close to body size.
- Use weight, color, and spacing before increasing font size.
- Reserve bold for genuinely important information.
- Prefer medium weight for labels and normal weight for values.
- Render secondary information with `theme.colors.foregroundMuted`.
- Keep line heights tight, but never clip glyphs or icons.
- Uppercase is acceptable for small section labels such as `OUTPUT` or `DIFF`. Do not use it for status pills or ordinary labels.

## Spacing

Use a compact spacing scale:

- 1-2 px: row separation and nested-list gaps
- 3-4 px: section gaps and compact block padding
- 5-7 px: row padding, icon gaps, and detail indentation
- 8 px: larger field alignment gaps
- 10 px or more: exceptional separation only

Do not make every value uniformly smaller. Preserve grouping by varying spacing:

- Tight spacing within one logical row
- Slightly more spacing between sections
- Indentation and guide lines between hierarchy levels

Avoid vertical margins on individual activity cards. The host timeline should provide the broader rhythm.

## Color

Use Paseo theme tokens. Do not hardcode background or foreground colors.

### Surfaces

- Prefer `surface0` for code and prompt backgrounds.
- Use transparent backgrounds for normal rows and expanded detail regions.
- Use `surface1` or `surface2` only for a subtle local distinction such as inline code.
- Avoid large saturated or category-tinted surfaces.

### Foreground

- Primary labels and values use `foreground`.
- Summaries, paths that should recede, metadata, guide labels, and inactive state use `foregroundMuted`.
- Ensure all visible text sets an explicit theme-derived color.

### Accents

Accent color is semantic, not decorative.

Good uses:

- Tool category icon
- Running, completed, failed, or canceled state
- Diff additions and deletions
- Links or active controls
- A narrow hero guide when a specialized detail view needs identification

Bad uses:

- Full activity-row backgrounds
- Large hero panels
- Icon circles or badges
- Status pill fills
- Decorative section backgrounds

Palette modes change accent intensity, not layout or density:

- `vivid`: restrained category accents on neutral rows
- `soft`: mostly neutral category icons, with color reserved for status
- `high_contrast`: stronger dividers and status colors

## Icons and controls

- Use Paseo's `Icon` component.
- Activity icons are normally 12 px.
- Nested activity icons are normally 11 px.
- Icons should not sit inside circular or rounded badges.
- Chevrons are small and muted.
- Keep hit areas usable through the row press target rather than visually enlarging the icon.
- Preserve accessibility labels, roles, expanded state, and disabled state.

## Detail content

### Fields

Render field data as aligned keys and values rather than cards.

- Keys use 10 px muted text.
- Values use 11 px primary text.
- Keep rows around a 15 px line height.
- Use about 90 px as the standard key column width.
- Separate rows by roughly 2 px.

### Lists

Use flat lists with thin row dividers.

- Do not give each result a background or rounded rectangle.
- Use a 1 px top divider when rows need separation.
- Keep list-item padding around 5 px horizontally and 3 px vertically.
- Use stable alignment and muted metadata to make results scannable.

### Status

Status is plain colored text or a small icon.

- Do not add a filled pill background.
- Do not uppercase status by default.
- Do not use bold unless the state requires immediate attention.

### Specialized headers

Specialized tool detail headers are compact identity rows, not hero cards.

- Use a small icon and 11 px label.
- A 2 px colored left guide may identify the tool category.
- Do not add a tinted background.
- Keep subtitle and status on the same compact line when possible.

## Code, output, and diffs

Code and command output can use a subtle surface because the content needs a fixed reading region.

- Use `surface0`, a 1 px theme border, and a 2 px radius.
- Keep horizontal padding around 6 px and vertical padding around 4 px.
- Use 11 px monospace text with 16 px line height.
- Keep output scrollable rather than allowing it to dominate the timeline.
- Apply diff color to changed lines only, with low-opacity backgrounds.
- Do not wrap code blocks in another prominent card.

## Reasoning

Reasoning follows the same visual system as tool activity.

- Label the row `Thinking`.
- Use the standard compact activity header.
- Render headings at body size with medium or semibold weight.
- Use muted bullets and quote guides.
- Use a 1 px neutral guide for blockquotes.
- Keep paragraph, list, and spacer gaps small.
- Avoid large bold section headings inside reasoning.

## Light mode

The density and hierarchy must remain unchanged in light mode.

- Continue using theme tokens rather than dark-mode constants.
- Keep backgrounds neutral and low-contrast.
- Verify borders do not become visually heavier than the content.
- Verify muted text still has enough contrast.
- Do not compensate for light mode with larger tinted panels.

## Implementation map

The visual system currently lives in:

- `client/activity.tsx`: shared style factory, activity rows, reasoning, details, code, diffs, and nested progress
- `client/paseo.tsx`: specialized tool details, fields, lists, statuses, prompts, and compact headers
- `client/child-agent.tsx`: child activity hierarchy
- `client/github.tsx`: GitHub-specific detail rows
- `shared/presentation.ts`: category and status palettes
- `client/settings.tsx`: palette descriptions

Keep shared layout values in `useActivityStyles`. Specialized renderers should consume `ActivityStyles` instead of creating a competing style system.

## Review checklist

Before merging a UI change, check:

- Can more useful activity fit on screen than before?
- Does the information remain easy to scan?
- Is any large background tint doing work that text, alignment, or a guide line could do?
- Is any section wrapped in a card without a strong reason?
- Are expanded sections free of enclosing borders and header dividers?
- Does nested activity read clearly through indentation and one thin guide?
- Are headings close to body size?
- Is bold used sparingly?
- Is metadata visibly quieter than primary content?
- Are icons small, unbadged, and functional?
- Are status colors sparse and meaningful?
- Do dark and light themes both use the same hierarchy?
- Are loading, empty, error, running, and completed states still clear?
- Do lint, typecheck, and tests pass?

When in doubt, remove visual treatment before adding more.
