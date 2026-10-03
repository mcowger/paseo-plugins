import type { ProviderContent, ProviderPrompt } from "@getpaseo/plugin/server/provider";

/**
 * Provider prompt content to native Pi prompt payload.
 *
 * Pi's RPC `prompt` command accepts a text `message` plus optional inline
 * `images` (base64 + MIME). This module performs the conversion and the boundary
 * checks the provider must own:
 *
 * - Inline image parts are validated (MIME allowlist, base64 framing, decoded
 *   size cap) before they are forwarded.
 * - When the selected model does not accept image input, images are never
 *   silently dropped or reported as consumed: the prompt carries an explicit,
 *   visible omission note instead.
 * - Non-image attachments become readable text. Uploaded files keep their
 *   host-materialized path only as a tool hint; this module never opens an
 *   arbitrary path, so it cannot be used to read credentials. A root-supplied
 *   sanctioned reader is the only path by which an uploaded image becomes
 *   inline model input.
 */

/** Decoded byte cap for a single inline image forwarded to Pi. */
export const MAX_PROMPT_IMAGE_BYTES = 10 * 1024 * 1024;
/**
 * Decoded byte cap across all inline images in one prompt. Pi echoes the whole
 * prompt back on a single stdout frame, so the aggregate must stay well under
 * the transport frame budget rather than only bounding each image.
 */
export const MAX_PROMPT_IMAGE_TOTAL_BYTES = 16 * 1024 * 1024;
/** Maximum number of inline images forwarded in one prompt. */
export const MAX_PROMPT_IMAGES = 16;

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

export interface PiPromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface BuildPiPromptResult {
  message: string;
  images?: PiPromptImage[];
}

export interface BuildPiPromptOptions {
  /**
   * Optional root-provided reader for a host-materialized uploaded image.
   *
   * The callback is responsible for canonicalizing and authorizing the path
   * (for example, restricting it to Paseo's uploads directory) and returning
   * base64 data or `null` when the path is not a sanctioned upload. This module
   * never reads a path on its own.
   */
  readUploadedImage?(input: { path: string; mimeType: string }): Promise<{ data: string } | null>;
}

function normalizeBase64(data: string): string | null {
  const stripped = data.replace(/\s+/g, "");
  if (stripped.length === 0 || stripped.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) return null;
  return stripped;
}

function decodedByteLength(normalized: string): number {
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return (normalized.length / 4) * 3 - padding;
}

function validateInlineImage(part: {
  data: string;
  mimeType: string;
}): PiPromptImage | { reason: string } {
  const mimeType = part.mimeType.toLowerCase();
  if (!IMAGE_MIME_TYPES.has(mimeType)) {
    return { reason: `unsupported image MIME type "${part.mimeType}"` };
  }
  const normalized = normalizeBase64(part.data);
  if (normalized === null) {
    return { reason: `malformed base64 image data for ${part.mimeType}` };
  }
  const bytes = decodedByteLength(normalized);
  if (bytes > MAX_PROMPT_IMAGE_BYTES) {
    return {
      reason: `image is ${bytes} bytes, above the ${MAX_PROMPT_IMAGE_BYTES}-byte limit`,
    };
  }
  return { type: "image", data: normalized, mimeType };
}

function omitImageNote(mimeType: string, bytes: number | null): string {
  const size = bytes === null ? "unknown size" : `${bytes} bytes`;
  return `[Image attachment omitted: the selected model does not accept image input (${mimeType}, ${size}). The image was not analyzed.]`;
}

interface ForgeFormat {
  label: string;
  changeRequest: string;
  issue: string;
}

const FORGE_FORMATS: Readonly<Record<string, ForgeFormat>> = {
  github: { label: "GitHub", changeRequest: "PR", issue: "Issue" },
  gitlab: { label: "GitLab", changeRequest: "MR", issue: "Issue" },
  bitbucket: { label: "Bitbucket", changeRequest: "PR", issue: "Issue" },
};

function forgeFormat(forge: string | undefined): ForgeFormat {
  const key = forge?.toLowerCase();
  const known = key ? FORGE_FORMATS[key] : undefined;
  if (known) return known;
  return { label: forge ?? "Forge", changeRequest: "PR", issue: "Issue" };
}

function renderChangeRequest(part: {
  forge?: string;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
  baseRefName?: string | null;
  headRefName?: string | null;
}): string {
  const format = forgeFormat(part.forge);
  const lines = [
    `${format.label} ${format.changeRequest} #${part.number}: ${part.title}`,
    part.url,
  ];
  if (part.projectPath) lines.push(`Project: ${part.projectPath}`);
  if (part.baseRefName) lines.push(`Base: ${part.baseRefName}`);
  if (part.headRefName) lines.push(`Head: ${part.headRefName}`);
  if (part.body) lines.push("", part.body);
  return lines.join("\n");
}

function renderIssue(part: {
  forge?: string;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
}): string {
  const format = forgeFormat(part.forge);
  const lines = [
    `${format.label} ${format.issue} #${part.number}: ${part.title}`,
    part.url,
  ];
  if (part.projectPath) lines.push(`Project: ${part.projectPath}`);
  if (part.body) lines.push("", part.body);
  return lines.join("\n");
}

function padLineNumber(lineNumber: number | null): string {
  return (lineNumber?.toString() ?? "-").padStart(2);
}

const REVIEW_LINE_MARKERS: Readonly<Record<"add" | "remove" | "context", string>> = {
  add: "+",
  remove: "-",
  context: " ",
};

function renderReview(part: Extract<ProviderContent, { type: "review" }>): string {
  const lines = [`Paseo review attachment (${part.mode})`, `CWD: ${part.cwd}`];
  if (part.baseRef) lines.push(`Base: ${part.baseRef}`);
  part.comments.forEach((comment, index) => {
    lines.push(
      "",
      `Comment ${index + 1}: ${comment.filePath}:${comment.side}:${comment.lineNumber}`,
      comment.body,
      comment.context.hunkHeader,
    );
    const target = comment.context.targetLine;
    for (const line of comment.context.lines) {
      const isTarget =
        line.oldLineNumber === target.oldLineNumber &&
        line.newLineNumber === target.newLineNumber &&
        line.type === target.type &&
        line.content === target.content;
      const prefix = isTarget ? "> " : "  ";
      lines.push(
        `${prefix}${padLineNumber(line.oldLineNumber)} ${padLineNumber(line.newLineNumber)} ${REVIEW_LINE_MARKERS[line.type]}${line.content}`,
      );
    }
  });
  return lines.join("\n");
}

function renderUploadedFileHint(part: {
  fileName: string;
  path: string;
  mimeType: string;
  size: number;
}): string {
  return [
    `Uploaded file: ${part.fileName}`,
    `Path: ${part.path}`,
    `MIME: ${part.mimeType}`,
    `Size: ${part.size} bytes`,
    "Use your file tools to read it.",
  ].join("\n");
}

export async function buildPiPrompt(
  prompt: ProviderPrompt,
  modelSupportsImages: boolean,
  options: BuildPiPromptOptions = {},
): Promise<BuildPiPromptResult> {
  if (prompt.input.type === "command") {
    const { name, arguments: args } = prompt.input;
    return { message: `/${name}${args ? ` ${args}` : ""}` };
  }

  const textParts: string[] = [];
  const images: PiPromptImage[] = [];
  let totalImageBytes = 0;

  function admitImage(image: PiPromptImage): void {
    const bytes = decodedByteLength(image.data);
    if (totalImageBytes + bytes > MAX_PROMPT_IMAGE_TOTAL_BYTES) {
      throw new Error(
        `Prompt images total ${totalImageBytes + bytes} bytes, above the ${MAX_PROMPT_IMAGE_TOTAL_BYTES}-byte aggregate limit`,
      );
    }
    totalImageBytes += bytes;
    images.push(image);
  }

  for (const part of prompt.input.content) {
    switch (part.type) {
      case "text":
        textParts.push(part.text);
        break;

      case "image": {
        const validated = validateInlineImage(part);
        if ("reason" in validated) {
          throw new Error(`Invalid prompt image: ${validated.reason}`);
        }
        if (!modelSupportsImages) {
          textParts.push(omitImageNote(part.mimeType, decodedByteLength(validated.data)));
          break;
        }
        if (images.length >= MAX_PROMPT_IMAGES) {
          throw new Error(`Prompt contains more than ${MAX_PROMPT_IMAGES} inline images`);
        }
        admitImage(validated);
        break;
      }

      case "uploaded_file": {
        const isImage = part.mimeType.toLowerCase().startsWith("image/");
        if (isImage && modelSupportsImages && options.readUploadedImage) {
          const read = await options.readUploadedImage({
            path: part.path,
            mimeType: part.mimeType,
          });
          if (read) {
            const validated = validateInlineImage({ data: read.data, mimeType: part.mimeType });
            if ("reason" in validated) {
              throw new Error(`Invalid uploaded image: ${validated.reason}`);
            }
            admitImage(validated);
            break;
          }
        }
        if (isImage && !modelSupportsImages) {
          textParts.push(omitImageNote(part.mimeType, part.size));
          textParts.push(renderUploadedFileHint(part));
          break;
        }
        textParts.push(renderUploadedFileHint(part));
        break;
      }

      case "forge_change_request":
        textParts.push(renderChangeRequest(part));
        break;

      case "github_pr":
        textParts.push(renderChangeRequest({ ...part, forge: "github" }));
        break;

      case "forge_issue":
        textParts.push(renderIssue(part));
        break;

      case "github_issue":
        textParts.push(renderIssue({ ...part, forge: "github" }));
        break;

      case "review":
        textParts.push(renderReview(part));
        break;

      default: {
        const exhaustive = part as { type: string };
        throw new Error(`Unsupported prompt content type: ${exhaustive.type}`);
      }
    }
  }

  const message = textParts.join("\n\n");
  return images.length > 0 ? { message, images } : { message };
}
