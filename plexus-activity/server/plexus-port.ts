import type { RecordPatch } from "../shared/row-model";
import type { KeyEntry, VerifyOutput } from "../shared/view";
import { getJson, openStream, type StreamHandle } from "./http";
import { toKeyEntries, toRecordPatches, toVerifyResult } from "./records";

/**
 * The Plexus HTTP surface this plugin uses. Kept behind an interface so the connection state machine
 * can be tested without a live Plexus.
 *
 * Endpoints (see `~/workspace/plexus/docs/openapi.yaml`):
 * - `GET /v0/management/events` — SSE stream (`:8044-8200`)
 * - `GET /v0/management/usage` — historical rows, used as backfill (`:4984`)
 * - `GET /v0/management/keys` — key map, admin only, contains decrypted secrets (`:3941`)
 * - `GET /v0/management/auth/verify` — credential probe (`management.ts:58-76`)
 *
 * All management routes authenticate with the `x-admin-key` header; there is no Bearer path.
 */

export interface BackfillResult {
  readonly status: number;
  readonly patches: RecordPatch[];
}

export interface KeysResult {
  readonly status: number;
  readonly keys: KeyEntry[];
}

export interface PlexusPort {
  verify(baseUrl: string, adminKey: string, signal?: AbortSignal): Promise<VerifyOutput>;
  listKeys(baseUrl: string, adminKey: string, signal?: AbortSignal): Promise<KeysResult>;
  backfill(
    baseUrl: string,
    adminKey: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<BackfillResult>;
  openEvents(
    baseUrl: string,
    adminKey: string,
    signal: AbortSignal,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<StreamHandle>;
}

function adminHeaders(adminKey: string): Record<string, string> {
  return { "x-admin-key": adminKey };
}

/** Redacts anything that could echo the credential back to the client or a log. */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\b(x-admin-key|authorization)\b.*/gi, "").trim() || "request failed";
}

function statusMessage(status: number): string {
  if (status === 401) return "Plexus rejected that admin key (HTTP 401).";
  if (status === 403) return "That key is not an admin key (HTTP 403).";
  return `Plexus returned HTTP ${status}.`;
}

export function createPlexusPort(): PlexusPort {
  return {
    async verify(baseUrl, adminKey, signal) {
      let response: { status: number; body: string };
      try {
        response = await getJson({
          url: `${baseUrl}/v0/management/auth/verify`,
          headers: adminHeaders(adminKey),
          signal,
          timeoutMs: 10_000,
        });
      } catch (error) {
        return { ok: false, role: null, keyName: null, error: describeFailure(error) };
      }

      if (response.status !== 200) {
        return { ok: false, role: null, keyName: null, error: statusMessage(response.status) };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch {
        return {
          ok: false,
          role: null,
          keyName: null,
          error: "Plexus returned an unreadable response.",
        };
      }

      const result = toVerifyResult(payload);
      if (!result.ok || result.role === null) {
        return { ok: false, role: null, keyName: null, error: "Plexus did not confirm that key." };
      }
      return { ok: true, role: result.role, keyName: result.keyName, error: null };
    },

    async listKeys(baseUrl, adminKey, signal) {
      let response: { status: number; body: string };
      try {
        response = await getJson({
          url: `${baseUrl}/v0/management/keys`,
          headers: adminHeaders(adminKey),
          signal,
        });
      } catch {
        return { status: 0, keys: [] };
      }
      if (response.status !== 200) return { status: response.status, keys: [] };

      try {
        return { status: response.status, keys: toKeyEntries(JSON.parse(response.body)) };
      } catch {
        return { status: response.status, keys: [] };
      }
    },

    async backfill(baseUrl, adminKey, limit, signal) {
      const query = new URLSearchParams({
        limit: String(limit),
        sortBy: "date",
        sortDir: "desc",
      });
      let response: { status: number; body: string };
      try {
        response = await getJson({
          url: `${baseUrl}/v0/management/usage?${query.toString()}`,
          headers: adminHeaders(adminKey),
          signal,
        });
      } catch {
        return { status: 0, patches: [] };
      }
      if (response.status !== 200) return { status: response.status, patches: [] };

      try {
        return { status: response.status, patches: toRecordPatches(JSON.parse(response.body)) };
      } catch {
        return { status: response.status, patches: [] };
      }
    },

    openEvents(baseUrl, adminKey, signal, onChunk) {
      return openStream({
        url: `${baseUrl}/v0/management/events`,
        headers: adminHeaders(adminKey),
        signal,
        onChunk,
      });
    },
  };
}
