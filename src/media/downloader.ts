import { createHash } from 'node:crypto';
import { isSafeAttachmentUrl } from './attachments.js';

export interface MediaDownloadOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** Redirect hops. Capped at three even if a larger value is supplied. */
  maxRedirects?: number;
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  sha256: string;
  size: number;
  contentType?: string;
  finalUrl: string;
  redirects: number;
}

export type MediaDownloadErrorCode =
  | 'UNSAFE_URL'
  | 'TOO_MANY_REDIRECTS'
  | 'INVALID_REDIRECT'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'INVALID_CONTENT_LENGTH'
  | 'TOO_LARGE'
  | 'EMPTY_BODY';

export class MediaDownloadError extends Error {
  constructor(readonly code: MediaDownloadErrorCode, message: string) {
    super(message);
    this.name = 'MediaDownloadError';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

function contentType(response: Response): string | undefined {
  const raw = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  return raw && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(raw) ? raw : undefined;
}

function declaredLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length');
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) throw new MediaDownloadError('INVALID_CONTENT_LENGTH', 'invalid Content-Length');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new MediaDownloadError('INVALID_CONTENT_LENGTH', 'invalid Content-Length');
  return value;
}

function abortReason(signal: AbortSignal): MediaDownloadError {
  return new MediaDownloadError(signal.aborted ? 'TIMEOUT' : 'HTTP_ERROR', signal.aborted ? 'media download timed out' : 'media download aborted');
}

/**
 * Downloads one already-vetted remote attachment with a strict byte budget.
 * Redirects are manual so every Location is checked against the same URL
 * boundary as initial Discord attachment metadata.
 */
export class SafeMediaDownloader {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #maxRedirects: number;

  constructor(options: MediaDownloadOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxRedirects = Math.min(3, options.maxRedirects ?? DEFAULT_MAX_REDIRECTS);
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) throw new Error('timeoutMs must be a positive safe integer');
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes <= 0) throw new Error('maxBytes must be a positive safe integer');
    if (!Number.isSafeInteger(this.#maxRedirects) || this.#maxRedirects < 0) throw new Error('maxRedirects must be a non-negative safe integer');
  }

  async download(sourceUrl: string): Promise<DownloadedMedia> {
    let current = sourceUrl;
    let redirects = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref?.();
    try {
      while (true) {
        if (!isSafeAttachmentUrl(current)) throw new MediaDownloadError('UNSAFE_URL', 'unsafe media URL');
        let response: Response;
        try {
          response = await this.#fetch(current, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: { accept: 'image/*,video/*,audio/*,text/plain,application/octet-stream;q=0.1' },
          });
        } catch (error) {
          if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortReason(controller.signal);
          throw error;
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          if (redirects >= this.#maxRedirects) throw new MediaDownloadError('TOO_MANY_REDIRECTS', 'media redirect limit exceeded');
          const location = response.headers.get('location');
          if (!location) throw new MediaDownloadError('INVALID_REDIRECT', 'redirect response has no Location');
          let next: string;
          try { next = new URL(location, current).toString(); }
          catch { throw new MediaDownloadError('INVALID_REDIRECT', 'redirect Location is invalid'); }
          if (!isSafeAttachmentUrl(next)) throw new MediaDownloadError('UNSAFE_URL', 'redirect points to an unsafe URL');
          current = next;
          redirects += 1;
          continue;
        }

        if (!response.ok) throw new MediaDownloadError('HTTP_ERROR', `media request failed: HTTP ${response.status}`);
        const length = declaredLength(response);
        if (length !== undefined && length > this.#maxBytes) throw new MediaDownloadError('TOO_LARGE', 'declared media size exceeds limit');
        if (!response.body) throw new MediaDownloadError('EMPTY_BODY', 'media response has no body');

        const chunks: Uint8Array[] = [];
        const hash = createHash('sha256');
        let size = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            let result;
            try { result = await reader.read(); }
            catch (error) {
              if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortReason(controller.signal);
              throw error;
            }
            if (result.done) break;
            const chunk = result.value;
            size += chunk.byteLength;
            if (size > this.#maxBytes) {
              await reader.cancel('media size limit exceeded').catch(() => {});
              throw new MediaDownloadError('TOO_LARGE', 'streamed media size exceeds limit');
            }
            hash.update(chunk);
            chunks.push(chunk);
          }
        } finally {
          reader.releaseLock();
        }

        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return { bytes, sha256: hash.digest('hex'), size, contentType: contentType(response), finalUrl: current, redirects };
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
