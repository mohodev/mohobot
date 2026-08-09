import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './event.js';
import { clearSecrets, registerSecret, scrub } from './logger.js';

describe('EventBus', () => {
  it('delivers payloads to subscribers', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('bot:started', ({ botId }) => void seen.push(botId));
    bus.emit('bot:started', { botId: 'main' });
    expect(seen).toEqual(['main']);
  });

  it('isolates a throwing subscriber from the emitter and siblings', () => {
    const onHandlerError = vi.fn();
    const bus = new EventBus({ onHandlerError });
    let reached = false;
    bus.on('bot:started', () => {
      throw new Error('subscriber blew up');
    });
    bus.on('bot:started', () => {
      reached = true;
    });
    expect(() => bus.emit('bot:started', { botId: 'main' })).not.toThrow();
    expect(reached).toBe(true);
    expect(onHandlerError).toHaveBeenCalledOnce();
  });

  it('captures async subscriber rejections', async () => {
    const onHandlerError = vi.fn();
    const bus = new EventBus({ onHandlerError });
    bus.on('bot:started', async () => {
      throw new Error('async boom');
    });
    bus.emit('bot:started', { botId: 'main' });
    await new Promise((r) => setTimeout(r, 10));
    expect(onHandlerError).toHaveBeenCalledOnce();
  });

  it('emitAsync awaits all handlers and still isolates failures', async () => {
    const onHandlerError = vi.fn();
    const bus = new EventBus({ onHandlerError });
    let slowDone = false;
    bus.on('bot:started', async () => {
      throw new Error('nope');
    });
    bus.on('bot:started', async () => {
      await new Promise((r) => setTimeout(r, 20));
      slowDone = true;
    });
    await bus.emitAsync('bot:started', { botId: 'main' });
    expect(slowDone).toBe(true);
    expect(onHandlerError).toHaveBeenCalledOnce();
  });

  it('off() and the returned unsubscribe both work', () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on('bot:started', () => void (count += 1));
    bus.emit('bot:started', { botId: 'a' });
    off();
    bus.emit('bot:started', { botId: 'a' });
    expect(count).toBe(1);
    expect(bus.listenerCount('bot:started')).toBe(0);
  });

  it('once() fires exactly one time', () => {
    const bus = new EventBus();
    let count = 0;
    bus.once('bot:started', () => void (count += 1));
    bus.emit('bot:started', { botId: 'a' });
    bus.emit('bot:started', { botId: 'a' });
    expect(count).toBe(1);
  });
});

describe('logger redaction', () => {
  it('masks a registered secret anywhere in a string', () => {
    clearSecrets();
    registerSecret('super-secret-token-value');
    expect(scrub('token=super-secret-token-value end')).toBe('token=[REDACTED] end');
    clearSecrets();
  });

  it('ignores secrets that are too short to mask safely', () => {
    clearSecrets();
    registerSecret('abc');
    expect(scrub('abc def')).toBe('abc def');
    clearSecrets();
  });

  it('masks bearer tokens and sk- keys it was never told about', () => {
    clearSecrets();
    expect(scrub('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123')).toContain('[REDACTED]');
    expect(scrub('key sk-abcdefghijklmnopqrst here')).toContain('[REDACTED]');
    expect(scrub('Bot MTIzNDU2Nzg5MDEyMzQ1Njc4.Abcdef.ghijklmnop')).toContain('[REDACTED]');
    clearSecrets();
  });
});
