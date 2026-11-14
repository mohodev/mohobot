import { describe, expect, it, vi } from 'vitest';
import { StreamingDelivery } from './streaming-delivery.js';

describe('StreamingDelivery', () => {
  it('waits for a sentence boundary after the soft limit', async () => {
    const flush = vi.fn(async () => true);
    const delivery = new StreamingDelivery(flush);
    const text = 'a'.repeat(180);

    delivery.push(text);
    expect(flush).not.toHaveBeenCalled();
    expect(delivery.received).toBe(true);

    delivery.push('。');
    expect(await delivery.finish()).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(text + '。', true);
    expect(delivery.sent).toBe(1);
  });

  it('forces bounded chunks at the hard limit and flushes the tail', async () => {
    const chunks: Array<{ text: string; first: boolean }> = [];
    const delivery = new StreamingDelivery(async (text, first) => {
      chunks.push({ text, first });
      return true;
    });

    delivery.push('x'.repeat(480));
    expect(await delivery.finish()).toBe(true);
    expect(chunks.map((chunk) => chunk.text)).toEqual(['x'.repeat(180), 'x'.repeat(300)]);
    expect(chunks.map((chunk) => chunk.first)).toEqual([true, false]);
  });

  it('returns false when every flush fails', async () => {
    const delivery = new StreamingDelivery(async () => false);
    delivery.push('partial response');
    expect(await delivery.finish()).toBe(false);
    expect(delivery.sent).toBe(0);
  });

  it('serializes asynchronous flushes in arrival order', async () => {
    const chunks: string[] = [];
    const delivery = new StreamingDelivery(async (text) => {
      await Promise.resolve();
      chunks.push(text);
      return true;
    });

    const first = 'a'.repeat(180) + '。';
    const second = 'b'.repeat(180) + '。';
    delivery.push(first);
    delivery.push(second);
    expect(await delivery.finish()).toBe(true);
    expect(chunks).toEqual([first, second]);
  });
});
