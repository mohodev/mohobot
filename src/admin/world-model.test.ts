import { describe, expect, it } from 'vitest';
import { createWorldEvent, transitionWorldEvent } from './world-model.js';

const event = () => createWorldEvent({ sourceKind: 'calendar', sourceId: 'feed-1', time: { start: '2026-08-13T10:00:00.000Z', end: '2026-08-13T12:00:00.000Z' }, scope: 'band', payload: { title: 'Show' }, phase: 'tour' });

describe('world event state machine', () => {
  it('creates deterministic events with normalized metadata', () => {
    const first = event();
    expect(event()).toEqual(first);
    expect(first.id).toMatch(/^world:[a-f0-9]{32}$/);
    expect(first.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.status).toBe('candidate');
  });
  it('follows candidate to phase-applied and completed', () => {
    let current = transitionWorldEvent(event(), 'confirm');
    current = transitionWorldEvent(current, 'activate');
    current = transitionWorldEvent(current, 'apply-phase', '2026-08-01T00:00:00.000Z');
    expect(current.status).toBe('phase-applied');
    expect(current.appliedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(transitionWorldEvent(current, 'apply-phase')).toEqual(current);
    expect(transitionWorldEvent(current, 'complete').status).toBe('completed');
  });
  it('supports rejection and expiration while refusing invalid transitions', () => {
    expect(transitionWorldEvent(event(), 'reject').status).toBe('rejected');
    expect(transitionWorldEvent(event(), 'expire').status).toBe('expired');
    expect(() => transitionWorldEvent(event(), 'complete')).toThrow();
  });
});
