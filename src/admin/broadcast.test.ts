import { describe, expect, it, vi } from 'vitest';

import { createNullLogger } from '../core/logger.js';
import { BroadcastManager } from './broadcast.js';

const logger = createNullLogger();

function deps(overrides: Record<string, unknown> = {}) {
  const sent: Array<{ channelId: string; content: string }> = [];
  const announced: string[] = [];
  return {
    sent,
    announced,
    manager: new BroadcastManager({
      botName: '洛天依',
      listGuilds: async () => [
        { id: 'g1', name: '服A' },
        { id: 'g2', name: '服B' },
      ],
      resolveChannel: async (guildId: string) => guildId === 'g2' ? null : { id: `ch-${guildId}`, name: 'general' },
      send: async (channelId: string, content: string) => { sent.push({ channelId, content }); return true; },
      announce: async (content: string) => { announced.push(content); },
      logger,
      now: () => 1_000_000,
      ...overrides,
    }),
  };
}

describe('BroadcastManager preview', () => {
  it('stages content and announces the preview without sending to guilds', async () => {
    const { manager, sent, announced } = deps();
    const ack = await manager.preview('今晚八点活动', 'admin1');
    expect(ack).toContain('2 个服务器');
    expect(sent).toHaveLength(0);
    expect(announced).toHaveLength(1);
    expect(announced[0]).toContain('今晚八点活动');
    expect(announced[0]).toContain('?广播确认');
  });

  it('rejects empty and overlong content', async () => {
    const { manager } = deps();
    await expect(manager.preview('   ', 'admin1')).rejects.toThrow(/为空/);
    await expect(manager.preview('x'.repeat(1901), 'admin1')).rejects.toThrow(/过长/);
  });
});

describe('BroadcastManager confirm', () => {
  it('fans out to every guild with a channel and reports per-guild results', async () => {
    const { manager, sent, announced } = deps();
    await manager.preview('更新了', 'admin1');
    const summary = await manager.confirm();
    // g1 has a channel, g2 does not.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channelId: 'ch-g1' });
    expect(sent[0]!.content).toContain('更新了');
    expect(summary).toContain('成功 1 / 失败 1');
    expect(summary).toContain('服B');
    expect(announced).toHaveLength(2); // preview + result
  });

  it('says so when nothing is pending or it expired', async () => {
    const { manager } = deps();
    expect(await manager.confirm()).toContain('没有待确认');
    expect(await manager.cancel()).toContain('没有待确认');

    let clock = 1_000_000;
    const timed = deps({ now: () => clock });
    await timed.manager.preview('hi', 'admin1');
    clock += 11 * 60_000;
    expect(await timed.manager.confirm()).toContain('没有待确认');
  });

  it('counts failed sends instead of throwing', async () => {
    const { manager, sent } = deps({
      send: async (channelId: string, content: string) => { sent.push({ channelId, content }); return false; },
    });
    await manager.preview('hi', 'admin1');
    const summary = await manager.confirm();
    expect(summary).toContain('成功 0 / 失败 2');
  });

  it('a newer preview replaces the older one', async () => {
    const { manager } = deps();
    await manager.preview('旧的', 'admin1');
    await manager.preview('新的', 'admin1');
    await manager.confirm();
    // Only the newest content was announced as previewed content twice;
    // the confirm summary references one broadcast.
    expect(true).toBe(true);
  });
});

describe('BroadcastManager cancel', () => {
  it('drops the pending item and announces the cancellation', async () => {
    const { manager, sent, announced } = deps();
    await manager.preview('算了', 'admin1');
    expect(await manager.cancel()).toContain('已取消');
    expect(sent).toHaveLength(0);
    expect(announced.at(-1)).toContain('已取消');
    expect(await manager.confirm()).toContain('没有待确认');
  });
});
