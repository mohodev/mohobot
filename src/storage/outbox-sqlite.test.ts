import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createNullLogger } from '../core/logger.js';
import { Outbox } from './outbox.js';
import { SqliteStorage } from './sqlite.js';

const roots: string[] = [];
const opened: SqliteStorage[] = [];

async function pair(): Promise<{ first: Outbox; second: Outbox; firstStorage:SqliteStorage;secondStorage:SqliteStorage }> {
  const root = await mkdtemp(path.join(tmpdir(), 'mohobot-outbox-atomic-'));
  roots.push(root);
  const databasePath = path.join(root, 'outbox.sqlite');
  const logger = createNullLogger();
  const firstStorage = new SqliteStorage({ path: databasePath, logger });
  await firstStorage.init();
  const secondStorage = new SqliteStorage({ path: databasePath, logger });
  await secondStorage.init();
  opened.push(firstStorage, secondStorage);
  return { first: new Outbox(firstStorage), second: new Outbox(secondStorage),firstStorage,secondStorage };
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((storage) => storage.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SQLite atomic outbox claims', () => {
  it('claims one event only once across two SQLite connections', async () => {
    const { first, second } = await pair();
    await first.append({ eventId: 'shared', type: 'test', payload: { value: 1 }, nextAttemptAt: 100 });

    const [a, b] = await Promise.all([
      first.claim('worker-a', { now: 100, leaseMs: 1_000, limit: 1 }),
      second.claim('worker-b', { now: 100, leaseMs: 1_000, limit: 1 }),
    ]);

    expect([...a, ...b]).toHaveLength(1);
    expect([...a, ...b][0]).toMatchObject({ eventId: 'shared', status: 'processing', attempts: 1 });
    expect([...a, ...b][0]?.claimToken).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('atomically retries failed events without overwriting a concurrent claim',async()=>{const{first,second,firstStorage,secondStorage}=await pair();await first.append({eventId:'retry-race',type:'test',payload:{},nextAttemptAt:1});const[claimed]=await first.claim('worker',{now:1,leaseMs:10,limit:1});await first.release('retry-race','worker',{claimToken:claimed!.claimToken!,error:'failed',now:2});const[retried,reclaimed]=await Promise.all([firstStorage.retryFailedOutboxAtomic('retry-race',3),second.claim('worker-2',{now:3,leaseMs:10,limit:1})]);expect(retried||reclaimed.length).toBeTruthy();const current=await second.get('retry-race');if(reclaimed.length){expect(current).toMatchObject({status:'processing',attempts:2,claimToken:reclaimed[0]!.claimToken});}else{expect(current).toMatchObject({status:'pending',attempts:1});}expect(secondStorage).toBeDefined();});

  it('fences a late release even when the workerId is reused', async () => {
    const { first, second } = await pair();
    await first.append({ eventId: 'leased', type: 'test', payload: {}, nextAttemptAt: 1_000 });
    const [oldClaim] = await first.claim('worker', { now: 1_000, leaseMs: 50, limit: 1 });
    const [newClaim] = await second.claim('worker', { now: 1_050, leaseMs: 100, limit: 1 });

    expect(newClaim?.claimToken).not.toBe(oldClaim?.claimToken);
    expect(newClaim?.attempts).toBe(2);
    const late = await first.release('leased', 'worker', {
      claimToken: oldClaim!.claimToken!,
      done: true,
      now: 1_060,
    });
    expect(late).toMatchObject({ status: 'processing', claimToken: newClaim!.claimToken, attempts: 2 });

    const done = await second.release('leased', 'worker', {
      claimToken: newClaim!.claimToken!,
      done: true,
      now: 1_070,
    });
    expect(done).toMatchObject({ status: 'done', attempts: 2 });
  });
});
