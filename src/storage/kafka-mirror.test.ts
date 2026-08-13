import { describe, expect, it, vi } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import type { OutboxEvent } from './outbox.js';
import { KafkaRemoteMirror, type KafkaProducerLike } from './kafka-mirror.js';

function event(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    eventId: 'evt-1',
    type: 'chat.archived',
    payload: { messageId: 'm1', content: 'hello' },
    status: 'processing',
    attempts: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    nextAttemptAt: 1_700_000_000_000,
    ...overrides,
  };
}

function producer(): KafkaProducerLike & {
  connect: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  return {
    connect: vi.fn(async () => {}),
    send: vi.fn(async () => ({ ok: true })),
    disconnect: vi.fn(async () => {}),
  };
}

describe('KafkaRemoteMirror', () => {
  it('publishes a versioned JSON envelope with eventId as the message key', async () => {
    const p = producer();
    const mirror = new KafkaRemoteMirror(p, createNullLogger(), { topicPrefix: 'moho.prod', schemaVersion: 2 });

    await mirror.send(event());

    expect(p.connect).toHaveBeenCalledTimes(1);
    expect(p.send).toHaveBeenCalledTimes(1);
    const input = p.send.mock.calls[0]?.[0] as { topic: string; messages: Array<{ key: string; value: string; headers: Record<string, string> }> };
    expect(input.topic).toBe('moho.prod.chat.archived');
    expect(input.messages[0]?.key).toBe('evt-1');
    expect(input.messages[0]?.headers).toEqual({ 'content-type': 'application/json', 'schema-version': '2' });
    expect(JSON.parse(input.messages[0]!.value)).toEqual({
      schemaVersion: 2,
      type: 'chat.archived',
      createdAt: 1_700_000_000_000,
      payload: { messageId: 'm1', content: 'hello' },
    });
    expect(input.messages[0]!.value).not.toContain('status');
    expect(input.messages[0]!.value).not.toContain('attempts');
  });

  it('sanitizes event types into a bounded fixed-prefix topic', async () => {
    const p = producer();
    const mirror = new KafkaRemoteMirror(p, createNullLogger(), { topicPrefix: 'mohobot.events' });
    await mirror.send(event({ type: ' World / Concert Confirmed !!! ' }));
    expect(p.send).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'mohobot.events.world-concert-confirmed',
    }));
  });

  it('rejects invalid prefixes and event data before touching the producer', async () => {
    const p = producer();
    expect(() => new KafkaRemoteMirror(p, createNullLogger(), { topicPrefix: '../other' })).toThrow('invalid Kafka topic prefix');
    const mirror = new KafkaRemoteMirror(p, createNullLogger());
    await expect(mirror.send(event({ eventId: '' }))).rejects.toThrow('invalid Kafka event key');
    await expect(mirror.send(event({ type: '///' }))).rejects.toThrow('cannot form a Kafka topic');
    await expect(mirror.send(event({ createdAt: Number.NaN }))).rejects.toThrow('invalid Kafka event createdAt');
    expect(p.connect).not.toHaveBeenCalled();
    expect(p.send).not.toHaveBeenCalled();
  });

  it('enforces the serialized payload byte limit', async () => {
    const p = producer();
    const mirror = new KafkaRemoteMirror(p, createNullLogger(), { maxPayloadBytes: 16 });
    await expect(mirror.send(event({ payload: { text: '这是一个很长的负载' } }))).rejects.toThrow('exceeds 16 bytes');
    expect(p.send).not.toHaveBeenCalled();
  });

  it('rejects non-JSON payloads', async () => {
    const p = producer();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const mirror = new KafkaRemoteMirror(p, createNullLogger());
    await expect(mirror.send(event({ payload: cyclic }))).rejects.toThrow('not JSON serializable');
    expect(p.send).not.toHaveBeenCalled();
  });

  it('connects lazily only once for repeated sends', async () => {
    const p = producer();
    const mirror = new KafkaRemoteMirror(p, createNullLogger());
    await Promise.all([mirror.send(event()), mirror.send(event({ eventId: 'evt-2' }))]);
    expect(p.connect).toHaveBeenCalledTimes(1);
    expect(p.send).toHaveBeenCalledTimes(2);
  });

  it('reports health without producing a business event', async () => {
    const p = producer();
    p.health = vi.fn(async () => true);
    const mirror = new KafkaRemoteMirror(p, createNullLogger());

    expect(await mirror.health()).toEqual({ ok: false, connected: false, closed: false });
    expect(p.send).not.toHaveBeenCalled();

    await mirror.send(event());
    expect(await mirror.health()).toEqual({ ok: true, connected: true, closed: false });
    expect(p.health).toHaveBeenCalledTimes(2);
  });

  it('surfaces send errors to OutboxWorker and includes them in health', async () => {
    const p = producer();
    p.send.mockRejectedValueOnce(new Error('broker unavailable'));
    const mirror = new KafkaRemoteMirror(p, createNullLogger());
    await expect(mirror.send(event())).rejects.toThrow('broker unavailable');
    expect(await mirror.health()).toEqual({ ok: true, connected: true, closed: false, lastError: 'broker unavailable' });
  });

  it('closes idempotently and rejects sends after close', async () => {
    const p = producer();
    const mirror = new KafkaRemoteMirror(p, createNullLogger());
    await mirror.send(event());
    await Promise.all([mirror.close(), mirror.close()]);
    expect(p.disconnect).toHaveBeenCalledTimes(1);
    expect(await mirror.health()).toMatchObject({ ok: false, connected: false, closed: true });
    await expect(mirror.send(event())).rejects.toThrow('Kafka mirror is closed');
  });

  it('is structurally compatible with the RemoteMirror contract', async () => {
    const p = producer();
    const mirror: import('./outbox-worker.js').RemoteMirror = new KafkaRemoteMirror(p, createNullLogger());
    await expect(mirror.send(event())).resolves.toBeUndefined();
  });
});
