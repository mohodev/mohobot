import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorldStore } from './world.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('World SQLite persistence', () => {
  it('migrates legacy state once and persists subsequent changes in SQLite', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-world-sqlite-'));
    roots.push(root);
    const file = path.join(root, 'data/world/state.json');
    const raw = JSON.stringify({ weather: 'rain', activity: 'reading' });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, raw);
    const first = new WorldStore(root);
    expect(await first.get()).toMatchObject({ weather: 'rain', activity: 'reading' });
    await first.save({ ...(await first.get()), location: 'library' });
    const second = new WorldStore(root);
    expect(await second.get()).toMatchObject({ weather: 'rain', location: 'library' });
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
  });
});
