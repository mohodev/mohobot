import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorldStore } from './world.js';
import type { WorldState } from './world.js';
import { validateScheduledEvent } from './world-events.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function makeStore(): Promise<{ store: WorldStore; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-daily-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  return { store: new WorldStore(root), root };
}

function dateAt(iso: string): number { return Date.parse(iso); }

describe('WorldStore daily-life integration', () => {
  it('generates a daily activity on an idle day', async () => {
    const { store } = await makeStore();
    const before = await store.get();
    expect(before.activity).toBe('idle');
    expect(before.location).toBe('online');

    const at = dateAt('2026-10-18T14:00:00Z');
    const after = await store.tick(at);

    expect(after.activity).not.toBe('idle');
    expect(after.location).toBeTruthy();
    expect(after.appliedPhases).toContain('daily:2026-10-18');
  });

  it('does not generate daily activity when a scheduled event is active', async () => {
    const { store } = await makeStore();
    const event = validateScheduledEvent({
      kind: 'concert',
      title: 'Live show',
      startsAt: '2026-10-18T10:00:00Z',
      endsAt: '2026-10-18T16:00:00Z',
      location: 'Shanghai',
      trust: 'confirmed',
    });
    await store.schedule(event);
    await store.confirmScheduled(event.id, 'confirmed');

    const at = dateAt('2026-10-18T12:00:00Z');
    const after = await store.tick(at);

    expect(after.location).toBe('Shanghai');
    expect(after.activity).toContain('Live show');
    expect(after.appliedPhases.some(k => k.startsWith('daily:'))).toBe(false);
  });

  it('does not regenerate daily activity on the same day', async () => {
    const { store } = await makeStore();
    const at = dateAt('2026-10-18T10:00:00Z');

    const first = await store.tick(at);
    expect(first.appliedPhases).toContain('daily:2026-10-18');
    const firstActivity = first.activity;
    const firstLocation = first.location;
    const firstEnergy = first.mood.energy;

    const second = await store.tick(at + 3_600_000);
    expect(second.activity).toBe(firstActivity);
    expect(second.location).toBe(firstLocation);
    expect(second.mood.energy).toBe(firstEnergy);
    expect(second.appliedPhases.filter(k => k === 'daily:2026-10-18')).toHaveLength(1);
  });

  it('writes back location, activity, and mood adjustments', async () => {
    const { store } = await makeStore();
    const before = await store.get();
    const energyBefore = before.mood.energy ?? 0.65;
    const stressBefore = before.mood.stress ?? 0.2;

    const at = dateAt('2026-10-18T14:00:00Z');
    const after = await store.tick(at);

    expect(typeof after.location).toBe('string');
    expect(after.location.length).toBeGreaterThan(0);
    expect(typeof after.activity).toBe('string');
    expect(after.activity.length).toBeGreaterThan(0);
    expect(after.mood.energy).not.toBe(energyBefore);
    expect(after.mood.stress).not.toBe(stressBefore);
    expect(after.mood.energy).toBeGreaterThanOrEqual(0);
    expect(after.mood.energy).toBeLessThanOrEqual(1);
    expect(after.mood.stress).toBeGreaterThanOrEqual(0);
    expect(after.mood.stress).toBeLessThanOrEqual(1);
  });

  it('generates different daily activities on different days', async () => {
    const { store } = await makeStore();

    const day1 = await store.tick(dateAt('2026-10-18T14:00:00Z'));
    expect(day1.appliedPhases).toContain('daily:2026-10-18');

    const day2 = await store.tick(dateAt('2026-10-19T14:00:00Z'));
    expect(day2.appliedPhases).toContain('daily:2026-10-19');
    expect(day2.appliedPhases).toContain('daily:2026-10-18');
  });

  it('persists daily state across store instances', async () => {
    const { root } = await makeStore();
    const store1 = new WorldStore(root);
    await store1.tick(dateAt('2026-10-18T14:00:00Z'));

    const store2 = new WorldStore(root);
    const state = await store2.get();
    expect(state.appliedPhases).toContain('daily:2026-10-18');
    expect(state.activity).not.toBe('idle');
  });
});
