import { describe, expect, it } from 'vitest';
import { buildInternalGuildPlan, type GuildInventory } from './guild-admin.js';

const inventory: GuildInventory = {
  guildId: '1535564960929681418', name: 'ForVOCTI', ownerId: '1352719954222383115', communityEnabled: false,
  channels: [
    { id: 'cat-text', name: '文字区', kind: 'category', position: 0 },
    { id: 'general', name: '常规', kind: 'text', parentId: 'cat-text', position: 1 },
    { id: 'bot', name: '机器人', kind: 'text', parentId: 'cat-text', position: 2 },
    { id: 'test', name: '测试', kind: 'text', parentId: 'cat-text', position: 3 },
  ], roles: [{ id: 'guild', name: '@everyone', position: 0, managed: false }],
};

describe('internal guild blueprint', () => {
  it('creates and organizes a safe internal-server blueprint without deletions or permission mutations', () => {
    const plan = buildInternalGuildPlan(inventory, new Date('2026-08-15T00:00:00.000Z'));
    expect(plan.guildId).toBe(inventory.guildId);
    expect(plan.communityEnabled).toBe(false);
    expect(plan.actions.some((action) => action.kind === 'create-category' && action.name === '管理区')).toBe(true);
    expect(plan.actions.some((action) => action.kind === 'create-text' && action.name === 'bot-控制台')).toBe(true);
    expect(plan.actions.every((action) => !String(action.kind).includes('delete') && !String(action.kind).includes('permission'))).toBe(true);
    expect(plan.preservedChannelIds).toContain('test');
  });
});
