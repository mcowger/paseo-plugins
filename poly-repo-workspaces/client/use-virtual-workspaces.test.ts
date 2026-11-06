import { expect, it, vi } from "vitest";
import { useVirtualWorkspaces } from "./use-virtual-workspaces";

const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  stateCursor: 0,
  refCursor: 0,
  effects: [] as Array<() => unknown>,
  list: vi.fn(),
}));

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = harness.stateCursor++;
    if (index >= harness.states.length) harness.states.push(initial);
    return [
      harness.states[index],
      (value: unknown) => {
        harness.states[index] = value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = harness.refCursor++;
    harness.refs[index] ??= { current: initial };
    return harness.refs[index];
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => unknown) => {
    harness.effects.push(fn);
  },
}));
vi.mock("@getpaseo/plugin/client", () => ({
  defineRpc: (definition: unknown) => definition,
  useRpc: () => harness.list,
  usePaseo: () => ({ workspaces: { subscribe: () => () => {} } }),
}));

function render() {
  harness.stateCursor = 0;
  harness.refCursor = 0;
  // biome-ignore lint/correctness/useHookAtTopLevel: this test supplies a deterministic hook harness.
  return useVirtualWorkspaces();
}

it("shows a slow response while coalescing refresh requests into one follow-up", async () => {
  let finishFirst: (value: unknown) => void = () => {};
  let finishSecond: (value: unknown) => void = () => {};
  harness.list
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSecond = resolve;
        }),
    );
  const initial = render();
  for (const effect of harness.effects) effect();
  initial.refresh();
  initial.refresh();
  expect(harness.list).toHaveBeenCalledTimes(1);
  finishFirst({ virtualWorkspaces: [{ virtualId: "first", state: "creating" }] });
  await Promise.resolve();
  expect(render().items[0]?.virtualId).toBe("first");
  expect(harness.list).toHaveBeenCalledTimes(2);
  finishSecond({ virtualWorkspaces: [{ virtualId: "second", state: "creating" }] });
  await Promise.resolve();
  expect(render().items[0]?.virtualId).toBe("second");
});
