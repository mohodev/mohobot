import { describe, expect, it } from 'vitest';
import { GlobalConfigSchema } from '../config/schema.js';
import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from './memory.js';
import { RemoteAuthoritativeUnsupportedError } from './remote-coordinator.js';
import { createRemoteRuntime } from './remote-runtime.js';

async function setup(remoteStorage: unknown = { mode: 'async-mirror', mysql: { enabled: true } }) {
  const storage = new MemoryStorage({ logger: createNullLogger() });
  await storage.init();
  const events = new EventBus();
  const config = GlobalConfigSchema.parse({ remoteStorage }).remoteStorage;
  return { storage, events, config };
}

describe('remote runtime wiring', () => {
  it('parses remote storage in global config and defaults local-only', () => {
    expect(GlobalConfigSchema.parse({}).remoteStorage.mode).toBe('local-only');
    expect(GlobalConfigSchema.parse({ remoteStorage: { mode: 'async-mirror', kafka: { enabled: true } } }).remoteStorage.kafka.enabled).toBe(true);
  });

  it('degrades async mirror without an injected driver and exposes health', async () => {
    const { storage, events, config } = await setup();
    const runtime = createRemoteRuntime({ config, storage, events, logger: createNullLogger() });
    runtime.coordinator.start();
    expect(runtime.coordinator.started).toBe(false);
    expect((await runtime.coordinator.health()).remote.mysql).toMatchObject({ enabled: true, ok: false, detail: 'driver not installed' });
    await runtime.coordinator.stop();
    await storage.close();
  });

  it('appends stable redacted message, thread and config events and unsubscribes', async () => {
    const { storage, events, config } = await setup({ mode: 'local-only' });
    const runtime = createRemoteRuntime({ config, storage, events, logger: createNullLogger() });
    events.emit('message:update', { botId:'bot', platform:'discord', messageId:'m1', location:{channelId:'c',kind:'guild-text'}, content:'SECRET BODY', authorId:'private-user', editedAt:10, partial:false });
    events.emit('message:delete', { botId:'bot', platform:'discord', messageId:'m2', location:{channelId:'c',kind:'guild-text'}, authorId:'private-user', deletedAt:11, partial:true });
    events.emit('thread:lifecycle', { botId:'bot', platform:'discord', action:'create', channelId:'t', parentChannelId:'c', forumPost:false, partial:false, occurredAt:12 });
    events.emit('config:reload:failed', { path:'/secret/config.yaml', error:'token=SECRET' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = await runtime.outbox.list();
    expect(rows.map((row) => row.type).sort()).toEqual(['config.reload-failed.v1','message.deleted.v1','message.updated.v1','thread.lifecycle.v1']);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(JSON.stringify(rows)).not.toContain('private-user');
    expect(JSON.stringify(rows)).not.toContain('/secret/config.yaml');
    await runtime.stopEventBridge();
    events.emit('config:reload', { path:'ignored' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await runtime.outbox.list()).toHaveLength(4);
    await runtime.coordinator.stop();
    await storage.close();
  });

  it('fails closed for remote-authoritative even with an injected mirror', async () => {
    expect(GlobalConfigSchema.parse({ remoteStorage:{mode:'remote-authoritative'} }).remoteStorage.mode).toBe('remote-authoritative');
    const { storage, events, config } = await setup({ mode:'remote-authoritative', mysql:{enabled:true} });
    expect(() => createRemoteRuntime({
      config, storage, events, logger:createNullLogger(),
      drivers:{ mysql:{ mirror:{send:async()=>{}}, health:async()=>({ok:true}) } },
    })).toThrow(RemoteAuthoritativeUnsupportedError);
    await storage.close();
  });
});
