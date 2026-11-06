import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * Minimal HTTP client for Plexus.
 *
 * Written against `node:http`/`node:https` instead of a package: the server bundle runs on Node 20,
 * the plugin subprocess is not guaranteed to resolve its own `node_modules`, and an SSE client needs
 * per-chunk delivery plus an abort path rather than a buffered body.
 */

export interface JsonResponse {
  readonly status: number;
  readonly body: string;
}

export interface JsonRequestOptions {
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function requestFor(url: URL) {
  return url.protocol === "https:" ? httpsRequest : httpRequest;
}

function abortError(): Error {
  return new Error("request aborted");
}

export function getJson(options: JsonRequestOptions): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    let settled = false;

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      action();
    };

    const request = requestFor(url)(
      url,
      { method: "GET", headers: { accept: "application/json", ...options.headers } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          settle(() =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        });
        response.on("error", (error) => settle(() => reject(error)));
      },
    );

    const timer = setTimeout(
      () => request.destroy(new Error("Plexus request timed out")),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    const onAbort = (): void => {
      request.destroy(abortError());
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    request.on("error", (error) => settle(() => reject(error)));
    request.end();
  });
}

export interface StreamHandle {
  /** HTTP status of the response; only 200 carries an event stream. */
  readonly status: number;
  /** Resolves when the response body ends, closes, or errors. */
  readonly completion: Promise<void>;
}

export interface StreamRequestOptions {
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly signal: AbortSignal;
  readonly onChunk: (chunk: Uint8Array) => void;
  readonly connectTimeoutMs?: number;
}

export function openStream(options: StreamRequestOptions): Promise<StreamHandle> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    let settled = false;

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      action();
    };

    const request = requestFor(url)(
      url,
      {
        method: "GET",
        headers: { accept: "text/event-stream", "cache-control": "no-cache", ...options.headers },
      },
      (response) => {
        const status = response.statusCode ?? 0;

        if (status !== 200) {
          response.resume();
          settle(() => resolve({ status, completion: Promise.resolve() }));
          return;
        }

        const completion = new Promise<void>((done) => {
          let ended = false;
          const finish = (): void => {
            if (ended) return;
            ended = true;
            done();
          };
          response.on("data", (chunk: Buffer) => options.onChunk(new Uint8Array(chunk)));
          response.on("end", finish);
          response.on("close", finish);
          response.on("error", finish);
          response.on("aborted", finish);
        });

        settle(() => resolve({ status, completion }));
      },
    );

    const timer = setTimeout(
      () => request.destroy(new Error("Plexus event stream timed out while connecting")),
      options.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    const onAbort = (): void => {
      request.destroy(abortError());
    };
    options.signal.addEventListener("abort", onAbort, { once: true });

    request.on("error", (error) => settle(() => reject(error)));
    request.end();
  });
}
