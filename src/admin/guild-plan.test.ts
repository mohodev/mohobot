import { describe, expect, it, vi } from 'vitest';
import { GuildPlanner, inventoryDigest, type GuildPlanAdapter } from './guild-plan.js';
import type { GuildInventory } from '../discord/guild-admin.js';

const inventory: GuildInventory = { guildId: 'g', name: 'Guild', ownerId: 'u', communityEnabled: false, channels: [], roles: [] };

describe('GuildPlanner', () => {
  it('digests canonical inventory and rejects stale plans', async () => {
    const adapter: GuildPlanAdapter = { inventory: async () => inventory, apply: vi.fn(async () => ({ applied: 1, skipped: 0 })) };
    const planner = new GuildPlanner(adapter);
    expect(inventoryDigest(inventory)).toHaveLength(64);
    await expect(planner.apply('bot', { guildId: 'g', generatedAt: '', communityEnabled: false, actions: [], preservedChannelIds: [], summary: { create: 0, move: 0, rename: 0, topic: 0 } }, 'stale', 'key')).rejects.toThrow('inventory changed');
    expect(adapter.apply).not.toHaveBeenCalled();
  });

  it('applies an idempotency key only once', async () => {
    let finish!: () => void;
    const apply = vi.fn(async () => { await new Promise<void>((resolve) => { finish = resolve; }); return { applied: 1, skipped: 0, results: [{ index: 0, status: 'applied' as const }] }; });
    const planner = new GuildPlanner({ inventory: async () => inventory, apply });
    const plan = { guildId: 'g', generatedAt: '', communityEnabled: false as const, actions: [], preservedChannelIds: [], summary: { create: 0, move: 0, rename: 0, topic: 0 } };
    const digest = inventoryDigest(inventory);
    const first = planner.apply('bot', plan, digest, 'request-1');
    const second = planner.apply('bot', plan, digest, 'request-1');
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    finish();
    expect(await first).toMatchObject({ applied: 1, idempotent: false });
    expect(await second).toMatchObject({ applied: 1, idempotent: true });
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
