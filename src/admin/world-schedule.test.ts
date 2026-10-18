import { describe, expect, it } from 'vitest';
import { emptySchedule, mergeSchedule, adminReviewBlock, activeBlocks, type ScheduleBlock } from './world-schedule.js';

function block(overrides?: Partial<ScheduleBlock>): ScheduleBlock {
  return {
    id: 'blk-1',
    label: '练习',
    startHour: 10,
    endHour: 12,
    recurring: false,
    sourceKind: 'manual',
    sourceId: 'admin-1',
    confidence: 0.8,
    adminStatus: 'pending',
    ...overrides,
  };
}

const NOW = Date.parse('2026-10-18T12:00:00.000Z');

describe('world schedule', () => {
  it('creates empty schedule', () => {
    const schedule = emptySchedule('char-1');
    expect(schedule.characterId).toBe('char-1');
    expect(schedule.blocks).toHaveLength(0);
  });

  it('merges incoming blocks into empty schedule', () => {
    const schedule = emptySchedule('char-1');
    const incoming = [block(), block({ id: 'blk-2', label: '午餐', startHour: 12, endHour: 13, confidence: 0.6 })];
    const merged = mergeSchedule(schedule, incoming, NOW);
    expect(merged.blocks).toHaveLength(2);
    expect(merged.blocks[0]!.label).toBe('练习');
    expect(merged.blocks[1]!.label).toBe('午餐');
  });

  it('higher confidence overrides lower confidence at same slot', () => {
    const existing = mergeSchedule(emptySchedule('char-1'), [block({ confidence: 0.5 })], NOW);
    const incoming = [block({ id: 'blk-override', confidence: 0.9, label: '练习' })];
    const merged = mergeSchedule(existing, incoming, NOW);
    expect(merged.blocks).toHaveLength(1);
    expect(merged.blocks[0]!.id).toBe('blk-override');
    expect(merged.blocks[0]!.confidence).toBe(0.9);
  });

  it('lower confidence does not override higher confidence', () => {
    const existing = mergeSchedule(emptySchedule('char-1'), [block({ confidence: 0.9 })], NOW);
    const incoming = [block({ id: 'blk-low', confidence: 0.3 })];
    const merged = mergeSchedule(existing, incoming, NOW);
    expect(merged.blocks).toHaveLength(1);
    expect(merged.blocks[0]!.id).toBe('blk-1');
  });

  it('drops expired blocks during merge', () => {
    const expired = block({ expiresAt: '2026-10-17T00:00:00.000Z' });
    const existing = mergeSchedule(emptySchedule('char-1'), [expired], Date.parse('2026-10-16T00:00:00Z'));
    const merged = mergeSchedule(existing, [], NOW);
    expect(merged.blocks).toHaveLength(0);
  });

  it('does not overwrite admin-rejected blocks', () => {
    const rejected = block({ adminStatus: 'rejected' });
    const existing = mergeSchedule(emptySchedule('char-1'), [rejected], NOW);
    const incoming = [block({ id: 'blk-new', confidence: 1.0 })];
    const merged = mergeSchedule(existing, incoming, NOW);
    expect(merged.blocks).toHaveLength(1);
    expect(merged.blocks[0]!.adminStatus).toBe('rejected');
  });

  it('admin approves a block', () => {
    const schedule = mergeSchedule(emptySchedule('char-1'), [block()], NOW);
    const reviewed = adminReviewBlock(schedule, 'blk-1', 'approved', NOW);
    expect(reviewed).toBeDefined();
    expect(reviewed!.blocks[0]!.adminStatus).toBe('approved');
  });

  it('admin rejects a block', () => {
    const schedule = mergeSchedule(emptySchedule('char-1'), [block()], NOW);
    const reviewed = adminReviewBlock(schedule, 'blk-1', 'rejected', NOW);
    expect(reviewed).toBeDefined();
    expect(reviewed!.blocks[0]!.adminStatus).toBe('rejected');
  });

  it('adminReviewBlock returns undefined for missing block', () => {
    const schedule = mergeSchedule(emptySchedule('char-1'), [block()], NOW);
    expect(adminReviewBlock(schedule, 'nonexistent', 'approved', NOW)).toBeUndefined();
  });

  it('activeBlocks excludes rejected and expired', () => {
    const blocks: ScheduleBlock[] = [
      block({ id: 'a', adminStatus: 'approved' }),
      block({ id: 'b', adminStatus: 'rejected', startHour: 14, endHour: 16 }),
      block({ id: 'c', adminStatus: 'pending', expiresAt: '2026-10-17T00:00:00.000Z', startHour: 16, endHour: 18 }),
      block({ id: 'd', adminStatus: 'pending', startHour: 18, endHour: 20 }),
    ];
    const schedule = mergeSchedule(emptySchedule('char-1'), blocks, Date.parse('2026-10-16T00:00:00Z'));
    const active = activeBlocks(schedule, NOW);
    expect(active.map((b) => b.id)).toEqual(['a', 'd']);
  });
});
