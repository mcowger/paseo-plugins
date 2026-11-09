/**
 * Adapted from lthieu96/paseo-chat-polish/client/views.tsx (MIT, see NOTICE): its `Diffstat` splits five squares between
 * added and removed lines, GitHub style.
 *
 * 0.8.0: the small diffstat strip of a fold summary and of each file in its expanded list. No imports, so the lazy fx
 * chunk can draw it without bundling the presentation code.
 */
export type DiffBlock = "add" | "remove" | "none";

/**
 * The small diffstat strip: `size` blocks, green for added and red for removed lines in proportion, gray for the rest.
 * Up to `size` lines get one block each; beyond that both kinds keep at least one block when both occur.
 */
export function diffBlocks(added: number, removed: number, size = 5): DiffBlock[] {
  const plus = Number.isFinite(added) && added > 0 ? Math.floor(added) : 0;
  const minus = Number.isFinite(removed) && removed > 0 ? Math.floor(removed) : 0;
  const total = plus + minus;
  let green = 0;
  let red = 0;
  if (total > 0 && total <= size) {
    green = plus;
    red = minus;
  } else if (total > size) {
    green = Math.round((plus / total) * size);
    if (plus > 0 && green === 0) green = 1;
    if (minus > 0 && green === size) green = size - 1;
    red = minus > 0 ? size - green : 0;
  }
  const blocks: DiffBlock[] = [];
  for (let index = 0; index < size; index++) blocks.push(index < green ? "add" : index < green + red ? "remove" : "none");
  return blocks;
}
