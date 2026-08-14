import { describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from './memory.js';
import { Outbox } from './outbox.js';
import { CompositeRemoteMirror, RemoteAuthoritativeUnsupportedError, RuntimeRemoteCoordinator } from './remote-coordinator.js';
import { RemoteStorageConfigSchema } from './remote-config.js';
import type { RemoteMirror } from './outbox-worker.js';

async function setup() {
  const storage = new MemoryStorage({ logger: createNullLogger() });
  await storage.init();
  return { storage, outbox: new Outbox(storage) };
}

describe('CompositeRemoteMirror', () => {
  it('waits for all mirrors and reports partial failure', async () => {
    const calls: string[] = [];
    const good: RemoteMirror = { async send() { calls.push('good'); } };
    const bad: RemoteMirror = { async send() { calls.push('bad'); throw new Error('kafka down'); } };
    await expect(new CompositeRemoteMirror([good, bad]).send({ eventId:'e', type:'x', payload:{}, status:'processing', attempts:1, createdAt:0, updatedAt:0, nextAttemptAt:0 })).rejects.toThrow('partially failed');
    expect(calls.sort()).toEqual(['bad', 'good']);
  });
});

describe('RuntimeRemoteCoordinator', () => {
  it('keeps local append available when async mirror has no driver', async () => {
    const { storage, outbox } = await setup();
    const config = RemoteStorageConfigSchema.parse({ mode:'async-mirror', mysql:{ enabled:true } });
    const coordinator = new RuntimeRemoteCoordinator({
      config, outbox, services:{ mirrors:[], health:async()=>({mysql:{enabled:true,ok:false,detail:'driver not installed'}}), close:async()=>{} }, logger:createNullLogger(),
    });
    const event = await coordinator.append({ eventId:'local-only', type:'test', payload:{ ok:true } });
    expect(event.status).toBe('pending');
    coordinator.start();
    expect(coordinator.started).toBe(false);
    expect((await coordinator.health()).local.available).toBe(true);
    await coordinator.stop();
    await storage.close();
  });

  it('starts, drains, reports health and closes worker before services', async () => {
    const { storage, outbox } = await setup();
    const order: string[] = [];
    const mirror: RemoteMirror = { async send() { order.push('send'); } };
    const services = { mirrors:[mirror], health:async()=>({mysql:{enabled:true,ok:true}}), close:async()=>{ order.push('services.close'); } };
    const config = RemoteStorageConfigSchema.parse({ mode:'async-mirror', mysql:{enabled:true}, worker:{pollIntervalMs:50,batchSize:2,concurrency:1} });
    const coordinator = new RuntimeRemoteCoordinator({ config, outbox, services, logger:createNullLogger() });
    await coordinator.append({ eventId:'one', type:'test', payload:1 });
    coordinator.start();
    expect(coordinator.started).toBe(true);
    expect(await coordinator.drain()).toBe(1);
    expect((await outbox.get('one'))?.status).toBe('done');
    expect((await coordinator.health()).worker.stats.sent).toBe(1);
    await coordinator.stop();
    expect(order).toEqual(['send','services.close']);
    await storage.close();
  });

  it('keeps partially delivered events retryable', async () => {
    const { storage, outbox } = await setup();
    const services = { mirrors:[{send:async()=>{}},{send:async()=>{throw new Error('kafka down');}}], health:async()=>({}), close:async()=>{} };
    const config = RemoteStorageConfigSchema.parse({ mode:'async-mirror', mysql:{enabled:true}, worker:{retryDelayMs:1000} });
    const coordinator = new RuntimeRemoteCoordinator({ config, outbox, services, logger:createNullLogger() });
    await coordinator.append({ eventId:'partial', type:'test', payload:{} });
    expect(await coordinator.drain()).toBe(1);
    expect(await outbox.get('partial')).toMatchObject({status:'failed',attempts:1});
    await coordinator.stop();
    await storage.close();
  });

  it('waits for an in-flight send before closing services', async () => {
    const { storage, outbox } = await setup();
    const order:string[]=[];
    let entered!:()=>void; let release!:()=>void;
    const started=new Promise<void>((resolve)=>{entered=resolve;});
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const services={mirrors:[{send:async()=>{order.push('send.start');entered();await gate;order.push('send.end');}}],health:async()=>({}),close:async()=>{order.push('services.close');}};
    const config=RemoteStorageConfigSchema.parse({mode:'async-mirror',mysql:{enabled:true},worker:{pollIntervalMs:5}});
    const coordinator=new RuntimeRemoteCoordinator({config,outbox,services,logger:createNullLogger()});
    await coordinator.append({eventId:'slow',type:'test',payload:{}});
    coordinator.start(); await started;
    const stopping=coordinator.stop();
    await Promise.resolve(); expect(order).toEqual(['send.start']);
    release(); await stopping;
    expect(order).toEqual(['send.start','send.end','services.close']);
    await storage.close();
  });

  it('rejects remote-authoritative explicitly', async () => {
    const { storage, outbox } = await setup();
    const config = RemoteStorageConfigSchema.parse({ mode:'remote-authoritative', mysql:{enabled:true} });
    expect(() => new RuntimeRemoteCoordinator({ config, outbox, services:{mirrors:[{send:async()=>{}}],health:async()=>({}),close:async()=>{}}, logger:createNullLogger() })).toThrow(RemoteAuthoritativeUnsupportedError);
    await storage.close();
  });
});
