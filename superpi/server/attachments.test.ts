import { describe, expect, test } from "vitest";
import type { ProviderContent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import {
  buildPiPrompt,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGE_TOTAL_BYTES,
} from "./attachments";

function messagePrompt(content: ProviderContent[]): ProviderPrompt {
  return {
    clientMessageId: "client-1",
    delivery: "auto",
    input: { type: "message", content },
  };
}

const PNG_BASE64 = Buffer.from("hello").toString("base64");

describe("buildPiPrompt images", () => {
  test("forwards validated inline images when the model supports them", async () => {
    const result = await buildPiPrompt(
      messagePrompt([
        { type: "text", text: "look" },
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      ]),
      true,
    );
    expect(result.message).toBe("look");
    expect(result.images).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
  });

  test("normalizes whitespace in base64 without corrupting it", async () => {
    const result = await buildPiPrompt(
      messagePrompt([{ type: "image", data: `${PNG_BASE64.slice(0, 4)}\n${PNG_BASE64.slice(4)}`, mimeType: "image/png" }]),
      true,
    );
    expect(result.images?.[0]?.data).toBe(PNG_BASE64);
  });

  test("makes text-only image limitations visible instead of claiming consumption", async () => {
    const result = await buildPiPrompt(
      messagePrompt([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]),
      false,
    );
    expect(result.images).toBeUndefined();
    expect(result.message).toContain("does not accept image input");
    expect(result.message).toContain("was not analyzed");
  });

  test("rejects malformed base64", async () => {
    await expect(
      buildPiPrompt(messagePrompt([{ type: "image", data: "not base64 !!", mimeType: "image/png" }]), true),
    ).rejects.toThrow(/malformed base64/);
  });

  test("rejects unsupported MIME types", async () => {
    await expect(
      buildPiPrompt(messagePrompt([{ type: "image", data: PNG_BASE64, mimeType: "image/svg+xml" }]), true),
    ).rejects.toThrow(/unsupported image MIME/);
  });

  test("rejects decoded images above the size cap", async () => {
    const oversized = Buffer.alloc(MAX_PROMPT_IMAGE_BYTES + 1).toString("base64");
    await expect(
      buildPiPrompt(messagePrompt([{ type: "image", data: oversized, mimeType: "image/png" }]), true),
    ).rejects.toThrow(/above the/);
  });
});

describe("buildPiPrompt uploaded files", () => {
  const uploaded = {
    type: "uploaded_file" as const,
    id: "upload-1",
    fileName: "shot.png",
    mimeType: "image/png",
    size: 5,
    path: "/home/user/.paseo/uploads/upload-1/shot.png",
  };

  test("never reads an uploaded path on its own, only emits a tool hint", async () => {
    const result = await buildPiPrompt(messagePrompt([uploaded]), true);
    expect(result.images).toBeUndefined();
    expect(result.message).toContain("Uploaded file: shot.png");
    expect(result.message).toContain(uploaded.path);
    expect(result.message).toContain("Use your file tools to read it.");
  });

  test("uses a sanctioned reader for an uploaded image when supplied", async () => {
    const calls: string[] = [];
    const result = await buildPiPrompt(messagePrompt([uploaded]), true, {
      readUploadedImage: async ({ path }) => {
        calls.push(path);
        return { data: PNG_BASE64 };
      },
    });
    expect(calls).toEqual([uploaded.path]);
    expect(result.images).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
  });

  test("falls back to the hint when the sanctioned reader declines the path", async () => {
    const result = await buildPiPrompt(messagePrompt([uploaded]), true, {
      readUploadedImage: async () => null,
    });
    expect(result.images).toBeUndefined();
    expect(result.message).toContain("Use your file tools to read it.");
  });

  test("notes an uploaded image on a text-only model without pretending to read it", async () => {
    const result = await buildPiPrompt(messagePrompt([uploaded]), false, {
      readUploadedImage: async () => ({ data: PNG_BASE64 }),
    });
    expect(result.images).toBeUndefined();
    expect(result.message).toContain("does not accept image input");
    expect(result.message).toContain("Use your file tools to read it.");
  });
});

describe("buildPiPrompt readable attachments", () => {
  test("renders forge change requests, issues, reviews, and text with context", async () => {
    const result = await buildPiPrompt(
      messagePrompt([
        {
          type: "forge_change_request",
          mimeType: "application/paseo-forge-change-request",
          forge: "gitlab",
          number: 42,
          title: "Fix parser",
          url: "https://gitlab.example/42",
          body: "Details",
          projectPath: "/repo",
          baseRefName: "main",
          headRefName: "fix",
        },
        {
          type: "github_issue",
          mimeType: "application/github-issue",
          number: 7,
          title: "Flaky test",
          url: "https://github.com/example/7",
          body: "Repro steps",
        },
        {
          type: "review",
          mimeType: "application/paseo-review",
          cwd: "/repo",
          mode: "uncommitted",
          baseRef: "main",
          comments: [
            {
              filePath: "src/a.ts",
              side: "new",
              lineNumber: 2,
              body: "nit",
              context: {
                hunkHeader: "@@ -1,2 +1,2 @@",
                targetLine: { oldLineNumber: null, newLineNumber: 2, type: "add", content: "new line" },
                lines: [
                  { oldLineNumber: 1, newLineNumber: 1, type: "context", content: "old line" },
                  { oldLineNumber: null, newLineNumber: 2, type: "add", content: "new line" },
                ],
              },
            },
          ],
        },
        { type: "text", mimeType: "text/plain", title: "Notes", text: "plain attachment body" },
      ]),
      false,
    );
    expect(result.message).toContain("GitLab MR #42: Fix parser");
    expect(result.message).toContain("Base: main");
    expect(result.message).toContain("GitHub Issue #7: Flaky test");
    expect(result.message).toContain("Repro steps");
    expect(result.message).toContain("Paseo review attachment (uncommitted)");
    expect(result.message).toContain(">  -  2 +new line");
    expect(result.message).toContain("plain attachment body");
  });

  test("renders command prompts", async () => {
    const prompt: ProviderPrompt = {
      clientMessageId: "client-2",
      delivery: "auto",
      input: { type: "command", name: "compact", arguments: "keep tests" },
    };
    const result = await buildPiPrompt(prompt, false);
    expect(result).toEqual({ message: "/compact keep tests" });
  });
});

describe("buildPiPrompt image aggregate", () => {
  test("admits multiple images while the decoded aggregate stays under the cap", async () => {
    const fourMiB = Buffer.alloc(4 * 1024 * 1024).toString("base64");
    const result = await buildPiPrompt(
      messagePrompt([
        { type: "image", data: fourMiB, mimeType: "image/png" },
        { type: "image", data: fourMiB, mimeType: "image/png" },
      ]),
      true,
    );
    expect(result.images).toHaveLength(2);
  });

  test("rejects a decoded aggregate above the cap even when each image is allowed", async () => {
    const nineMiB = Buffer.alloc(9 * 1024 * 1024).toString("base64");
    await expect(
      buildPiPrompt(
        messagePrompt([
          { type: "image", data: nineMiB, mimeType: "image/png" },
          { type: "image", data: nineMiB, mimeType: "image/png" },
        ]),
        true,
      ),
    ).rejects.toThrow(/aggregate limit/);
    expect(MAX_PROMPT_IMAGE_TOTAL_BYTES).toBe(16 * 1024 * 1024);
  });
});
