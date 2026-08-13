import { describe, expect, it } from 'vitest';
import { mergeEventCandidate, mayAutoConfirm } from './event-intelligence.js';
const base={kind:'concert' as const,title:'Live',startsAt:'2099-08-13T10:00:00Z',endsAt:'2099-08-13T12:00:00Z',location:'Shanghai'};
describe('event intelligence',()=>{it('scores independent official evidence and keeps candidate status',()=>{const e=mergeEventCandidate(base,[{url:'https://artist.example/live',source:'artist',kind:'official',observedAt:new Date().toISOString()},{url:'https://venue.example/event',source:'venue',kind:'official',observedAt:new Date().toISOString()}]);expect(e.trust).toBe('candidate');expect(e.confidence).toBe(1);expect(mayAutoConfirm(e)).toBe(true);});});
