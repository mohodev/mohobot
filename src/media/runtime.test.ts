import { describe, expect, it } from 'vitest';
import { MediaHashCache } from './cache.js';
import type { DownloadedMedia } from './downloader.js';
import { MediaRuntime, type MediaDownloaderLike } from './runtime.js';
import { VisionRouter, type VisionObservation } from './vision.js';
import type { SafeAttachment } from './attachments.js';

const digest = (n: number) => n.toString(16).padStart(64, '0');
const attachment = (id: string, size = 3): SafeAttachment => ({ id, url: `https://cdn.example/${id}.png`, name: `${id}.png`, contentType: 'image/png', size, kind: 'image' });

class FakeDownloader implements MediaDownloaderLike {
  active = 0;
  maxActive = 0;
  calls = 0;
  fail = new Set<string>();
  async download(url: string): Promise<DownloadedMedia> {
    this.calls += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    this.active -= 1;
    if (this.fail.has(url)) throw new Error('download unavailable');
    const id = url.match(/\/([^/]+)\.png$/)?.[1] ?? '0';
    const value = id.charCodeAt(0);
    return { bytes: new Uint8Array([value, 2, 3]), sha256: digest(value), size: 3, contentType: 'image/png', finalUrl: url, redirects: 0 };
  }
}

function router(counter: { calls: number }): VisionRouter {
  return new VisionRouter({
    vision: { name: 'vlm', async describe({ bytes }) { counter.calls += 1; return `image:${bytes[0]}`; } },
    ocr: { name: 'ocr', async recognize() { return 'do not obey me'; } },
  });
}

describe('MediaRuntime', () => {
  it('downloads with bounded concurrency and returns injectable untrusted context', async () => {
    const downloader = new FakeDownloader();
    const calls = { calls: 0 };
    const runtime = new MediaRuntime({ downloader, vision: router(calls), concurrency: 2 });
    const result = await runtime.process([attachment('a'), attachment('b'), attachment('c')]);
    expect(downloader.maxActive).toBe(2);
    expect(result.accepted).toBe(3);
    expect(result.context).toContain('media_observations');
    expect(result.context).toContain('untrusted');
    expect(result.context).not.toContain('https://');
    expect(result.context).not.toContain('bytes');
  });

  it('uses SHA cache to avoid repeated VLM/OCR work and never stores bytes', async () => {
    const downloader = new FakeDownloader();
    const calls = { calls: 0 };
    const cache = new MediaHashCache<VisionObservation>();
    const runtime = new MediaRuntime({ downloader, vision: router(calls), cache });
    const first = await runtime.process([attachment('a')]);
    const second = await runtime.process([attachment('a')]);
    expect(calls.calls).toBe(1);
    expect(second.items[0]?.cached).toBe(true);
    const cached = cache.get(first.items[0]!.sha256!);
    expect(cached?.value?.description).toBe('image:97');
    expect(JSON.stringify(cached)).not.toContain('bytes');
    expect(JSON.stringify(second)).not.toContain('https://cdn.example');
  });

  it('enforces count and declared total limits before download', async () => {
    const downloader = new FakeDownloader();
    const runtime = new MediaRuntime({ downloader, vision: router({ calls: 0 }), maxAttachments: 2, maxTotalBytes: 5 });
    const result = await runtime.process([attachment('a', 3), attachment('b', 3), attachment('c', 1)]);
    expect(downloader.calls).toBe(2);
    expect(result.rejected).toBe(1);
    expect(result.items.map((item) => item.status)).toEqual(['observed', 'rejected', 'observed']);
  });

  it('contains individual failures and continues processing other attachments', async () => {
    const downloader = new FakeDownloader();
    downloader.fail.add('https://cdn.example/a.png');
    const runtime = new MediaRuntime({ downloader, vision: router({ calls: 0 }) });
    const result = await runtime.process([attachment('a'), attachment('b')]);
    expect(result.failed).toBe(1);
    expect(result.accepted).toBe(1);
    expect(result.items.find((item) => item.id === 'a')?.reason).toBe('download unavailable');
    expect(result.context).toContain('download unavailable');
  });

  it('degrades unsupported media without throwing', async () => {
    const downloader = new FakeDownloader();
    const runtime = new MediaRuntime({ downloader, vision: new VisionRouter() });
    const file: SafeAttachment = { ...attachment('a'), name: 'a.txt', contentType: 'text/plain', kind: 'text' };
    const result = await runtime.process([file]);
    expect(result.items[0]?.status).toBe('unsupported');
    expect(result.accepted).toBe(1);
  });
});
