import { describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import type { OutboxEvent } from './outbox.js';
import { MySqlRemoteMirror, type MySqlClientLike } from './mysql-mirror.js';
import type { RemoteMirror } from './outbox-worker.js';

function event(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    eventId: 'event-1',
    type: 'chat.archive',
    payload: { text: 'hello', nested: { count: 1 } },
    status: 'processing',
    attempts: 2,
    createdAt: 100,
    updatedAt: 200,
    nextAttemptAt: 200,
    workerId: 'worker',
    claimExpiresAt: 1_000,
    ...overrides,
  };
}

class RecordingClient implements MySqlClientLike {
  calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  async execute(sql: string, params?: readonly unknown[]): Promise<unknown> {
    this.calls.push({ sql, params });
    return [{ affectedRows: 1 }];
  }
}

describe('MySqlRemoteMirror', () => {
  it('is structurally compatible with RemoteMirror', () => {
    const mirror: RemoteMirror = new MySqlRemoteMirror(new RecordingClient(), { logger: createNullLogger() });
    expect(typeof mirror.send).toBe('function');
  });

  it('initializes a fixed idempotent schema', async () => {
    const client = new RecordingClient();
    const mirror = new MySqlRemoteMirror(client, { logger: createNullLogger() });
    await mirror.init();
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.sql).toContain('CREATE TABLE IF NOT EXISTS `mohobot_outbox_events`');
    expect(client.calls[0]?.sql).toContain('PRIMARY KEY (event_id)');
    expect(client.calls[0]?.params).toBeUndefined();
  });

  it('uses parameterized SQL and event_id idempotency without overwriting data', async () => {
    const client = new RecordingClient();
    const mirror = new MySqlRemoteMirror(client, { logger: createNullLogger() });
    await mirror.send(event());
    const call = client.calls[0]!;
    expect(call.sql).toContain('VALUES (?, ?, CAST(? AS JSON), ?, ?, ?)');
    expect(call.sql).toContain('ON DUPLICATE KEY UPDATE event_id = VALUES(event_id)');
    expect(call.sql).not.toContain('hello');
    expect(call.params).toEqual(['event-1', 'chat.archive', '{"text":"hello","nested":{"count":1}}', 100, 200, 2]);
  });

  it('accepts only safe SQL identifiers for custom table names', () => {
    expect(() => new MySqlRemoteMirror(new RecordingClient(), { logger: createNullLogger(), table: 'events; DROP TABLE users' })).toThrow('invalid MySQL mirror table name');
    expect(() => new MySqlRemoteMirror(new RecordingClient(), { logger: createNullLogger(), table: 'tenant.events' })).toThrow('invalid MySQL mirror table name');
    expect(() => new MySqlRemoteMirror(new RecordingClient(), { logger: createNullLogger(), table: 'tenant_events_01' })).not.toThrow();
  });

  it('returns safe health results without exposing driver errors', async () => {
    const secret = 'mysql://admin:password@secret-host/database';
    const client: MySqlClientLike = { async execute() { throw new Error(secret); } };
    const mirror = new MySqlRemoteMirror(client, { logger: createNullLogger() });
    expect(await mirror.health()).toEqual({ ok: false, detail: 'unavailable' });
    expect(JSON.stringify(await mirror.health())).not.toContain(secret);
  });

  it('sanitizes init and delivery errors before they reach callers or Outbox', async () => {
    const secret = 'mysql://admin:password@secret-host/database';
    const client: MySqlClientLike = { async execute() { throw new Error(secret); } };
    const mirror = new MySqlRemoteMirror(client, { logger: createNullLogger() });
    await expect(mirror.init()).rejects.toThrow('MySQL mirror initialization failed');
    let error: unknown;
    try { await mirror.send(event()); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('MySQL mirror delivery failed');
    expect((error as Error).message).not.toContain(secret);
  });

  it('rejects payloads that cannot be encoded as JSON before executing SQL', async () => {
    const client = new RecordingClient();
    const mirror = new MySqlRemoteMirror(client, { logger: createNullLogger() });
    await expect(mirror.send(event({ payload: undefined }))).rejects.toThrow('outbox payload is not JSON serializable');
    expect(client.calls).toHaveLength(0);
  });
});
