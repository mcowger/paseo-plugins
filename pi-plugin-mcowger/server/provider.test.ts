import { expect, test } from "vitest";

import { createPiProvider } from "./provider.js";

test("contribution cleanup closes active provider connections", async () => {
  const provider = createPiProvider();
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message"],
  });

  await provider.close();

  await expect(connection.send({
    type: "sessions",
    requestId: "request-1",
  })).rejects.toThrow("Pi provider connection is closed");
});
