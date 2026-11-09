import { describe, expect, it } from "vitest";
import { badgeInk, commandBadge, fileBadge } from "./brand";

describe("language and tool chips", () => {
  it("labels files by well-known name, then by extension", () => {
    expect(fileBadge("src/app.ts")).toEqual({ label: "TS", color: "#3178C6", ink: "light" });
    expect(fileBadge("/repo/Dockerfile")?.label).toBe("DOCKER");
    expect(fileBadge("C:\\repo\\package.json")?.label).toBe("NPM");
    expect(fileBadge("notes.MD")?.label).toBe("MD");
    expect(fileBadge("README")).toBeNull();
    expect(fileBadge("weird.")).toBeNull();
    expect(fileBadge(undefined)).toBeNull();
  });

  it("finds the real program of a command behind cd, env vars and wrappers", () => {
    expect(commandBadge("git commit -m x")?.label).toBe("git");
    expect(commandBadge("cd /tmp/demo && npm test -- --reporter=dot")?.label).toBe("npm");
    expect(commandBadge("FOO=1 BAR=2 pnpm build")?.label).toBe("pnpm");
    expect(commandBadge("timeout 30 python3 -I - <<'EOF'")?.label).toBe("py");
    expect(commandBadge("sudo -E docker ps")?.label).toBe("docker");
    expect(commandBadge("/usr/bin/node script.mjs")?.label).toBe("node");
    expect(commandBadge("ls -la | grep x")).toBeNull();
    expect(commandBadge("cat a.txt")).toBeNull();
    expect(commandBadge("")).toBeNull();
  });

  it("picks readable ink for the chip colour", () => {
    expect(badgeInk(fileBadge("a.js")!)).toBe("#111317");
    expect(badgeInk(fileBadge("a.ts")!)).toBe("#FFFFFF");
  });
});
