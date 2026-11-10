import { describe, expect, it } from "vitest";
import { splitWaitTextNotices } from "./omp-wait-notice";

describe("splitWaitTextNotices", () => {
  it("extracts multiple notices and preserves intervening text", () => {
    expect(splitWaitTextNotices("before\n<system-notice>first **notice**</system-notice>middle<system-notice>second</system-notice>after")).toEqual([
      { kind: "text", text: "before\n" },
      { kind: "notice", text: "first **notice**" },
      { kind: "text", text: "middle" },
      { kind: "notice", text: "second" },
      { kind: "text", text: "after" },
    ]);
  });

  it("leaves malformed and unrecognized markup untouched", () => {
    const source = "<system-notice>unfinished <unknown>literal</unknown>";
    expect(splitWaitTextNotices(source)).toEqual([{ kind: "text", text: source }]);
  });

  it("returns empty parts for empty text", () => {
    expect(splitWaitTextNotices("")).toEqual([]);
  });
});
