import { describe, expect, it } from 'vitest';
import { collectCandidate, shouldCollectExternally } from './event-sources.js';
describe('event source policy',()=>{it('only sends public events to external collection',()=>{expect(shouldCollectExternally('concert')).toBe(true);expect(shouldCollectExternally('trip')).toBe(false);expect(()=>collectCandidate({kind:'trip',title:'逛街',startsAt:'2099-01-01T10:00:00Z',endsAt:'2099-01-01T11:00:00Z',location:'附近'},[])).toThrow();});});
