import { describe, expect, it } from 'vitest';
import { TopicBuffer } from './topic-buffer.js';
import type { MohoMessage } from '../core/types.js';

const message = (id: string, content: string, dm = false): MohoMessage => ({ id, platform: 'console', botId: 'b', channel: { id: 'c', dm }, author: { id: 'u', username: 'u', bot: false }, content, mentionsBot: false, attachments: [], createdAt: 0 });
describe('TopicBuffer', () => {
  it('coalesces a consecutive group turn after a quiet window', async () => {
    const buffer = new TopicBuffer({ quietMs: 5 });
    const first = buffer.push('k', message('1', '第一句'));
    const second = buffer.push('k', message('2', '第二句'));
    await expect(first).resolves.toMatchObject({ id: '2', content: '第一句\n第二句' });
    await expect(second).resolves.toMatchObject({ id: '2', content: '第一句\n第二句' });
  });
  it('resolves waiting callers when cleared during shutdown', async () => {
    const buffer = new TopicBuffer({ quietMs: 5000 });
    const pending = buffer.push('k', message('1', 'waiting'));
    buffer.clear();
    await expect(pending).resolves.toMatchObject({ id: '1' });
  });
  it('does not delay direct or private messages', async () => {
    const buffer = new TopicBuffer({ quietMs: 500 });
    await expect(buffer.push('k', { ...message('1', 'hi'), mentionsBot: true })).resolves.toMatchObject({ id: '1' });
    await expect(buffer.push('k', message('2', 'hi', true))).resolves.toMatchObject({ id: '2' });
  });
});
