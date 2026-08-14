import { describe, expect, it, vi } from 'vitest';
import { MediaDownloadError, SafeMediaDownloader } from './downloader.js';

function stream(chunks: Uint8Array[], delayMs = 0): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk); else controller.close();
    },
  });
}

function response(body: Uint8Array[] | null, init: ResponseInit = {}): Response {
  return new Response(body ? stream(body) : null, init);
}

function code(error: unknown): string | undefined { return error instanceof MediaDownloadError ? error.code : undefined; }

describe('SafeMediaDownloader', () => {
  it('downloads, streams, and hashes safe media', async () => {
    const fetchImpl = vi.fn(async () => response([new Uint8Array([1, 2]), new Uint8Array([3])], { status: 200, headers: { 'content-length': '3', 'content-type': 'image/png; charset=binary' } })) as unknown as typeof fetch;
    const result = await new SafeMediaDownloader({ fetchImpl }).download('https://cdn.discordapp.com/file.png');
    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(result.sha256).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
    expect(result).toMatchObject({ size: 3, contentType: 'image/png', redirects: 0 });
    expect(fetchImpl).toHaveBeenCalledWith('https://cdn.discordapp.com/file.png', expect.objectContaining({ redirect: 'manual' }));
  });

  it('checks every redirect and accepts safe relative hops', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith('/start')) return response(null, { status: 302, headers: { location: '/middle' } });
      if (value.endsWith('/middle')) return response(null, { status: 307, headers: { location: 'https://media.example/final' } });
      return response([new TextEncoder().encode('ok')], { status: 200 });
    }) as unknown as typeof fetch;
    const result = await new SafeMediaDownloader({ fetchImpl }).download('https://media.example/start');
    expect(result.redirects).toBe(2);
    expect(result.finalUrl).toBe('https://media.example/final');
  });

  it('enforces an exact host allowlist on initial and redirected URLs', async () => {
    const fetchImpl = vi.fn(async () => response(null, { status: 302, headers: { location: 'https://evil.example/file' } })) as unknown as typeof fetch;
    const downloader = new SafeMediaDownloader({ fetchImpl, hostAllowlist: ['cdn.discordapp.com', 'media.discordapp.net'] });
    await expect(downloader.download('https://example.com/file')).rejects.toSatisfy((error: unknown) => code(error) === 'UNSAFE_URL');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(downloader.download('https://cdn.discordapp.com/start')).rejects.toSatisfy((error: unknown) => code(error) === 'UNSAFE_URL');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects redirects to private or local targets before fetching them', async () => {
    const fetchImpl = vi.fn(async () => response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })) as unknown as typeof fetch;
    await expect(new SafeMediaDownloader({ fetchImpl }).download('https://media.example/start')).rejects.toSatisfy((error: unknown) => code(error) === 'UNSAFE_URL');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caps redirects at three hops', async () => {
    let hop = 0;
    const fetchImpl = vi.fn(async () => response(null, { status: 302, headers: { location: `https://media.example/${++hop}` } })) as unknown as typeof fetch;
    await expect(new SafeMediaDownloader({ fetchImpl, maxRedirects: 99 }).download('https://media.example/start')).rejects.toSatisfy((error: unknown) => code(error) === 'TOO_MANY_REDIRECTS');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('rejects an oversized declared length without consuming the body', async () => {
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-length': '11' } })) as unknown as typeof fetch;
    await expect(new SafeMediaDownloader({ fetchImpl, maxBytes: 10 }).download('https://media.example/file')).rejects.toSatisfy((error: unknown) => code(error) === 'TOO_LARGE');
  });

  it('enforces the byte budget while streaming without Content-Length', async () => {
    const fetchImpl = vi.fn(async () => response([new Uint8Array(6), new Uint8Array(6)], { status: 200 })) as unknown as typeof fetch;
    await expect(new SafeMediaDownloader({ fetchImpl, maxBytes: 10 }).download('https://media.example/file')).rejects.toSatisfy((error: unknown) => code(error) === 'TOO_LARGE');
  });

  it('aborts slow downloads at the configured timeout', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    })) as unknown as typeof fetch;
    await expect(new SafeMediaDownloader({ fetchImpl, timeoutMs: 5 }).download('https://media.example/file')).rejects.toSatisfy((error: unknown) => code(error) === 'TIMEOUT');
  });

  it('rejects unsafe initial URLs and invalid content lengths', async () => {
    const fetchImpl = vi.fn(async () => response([], { status: 200, headers: { 'content-length': '-1' } })) as unknown as typeof fetch;
    await expect(new SafeMediaDownloader({ fetchImpl }).download('http://localhost/file')).rejects.toSatisfy((error: unknown) => code(error) === 'UNSAFE_URL');
    await expect(new SafeMediaDownloader({ fetchImpl }).download('https://media.example/file')).rejects.toSatisfy((error: unknown) => code(error) === 'INVALID_CONTENT_LENGTH');
  });
});
