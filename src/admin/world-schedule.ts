import type { WorldSourceKind } from './world-events.js';

export interface ScheduleBlock {
  id: string;
  label: string;
  startHour: number;
  endHour: number;
  location?: string;
  activity?: string;
  recurring: boolean;
  dayOfWeek?: number;
  sourceKind: WorldSourceKind;
  sourceId: string;
  confidence: number;
  expiresAt?: string;
  adminStatus: 'pending' | 'approved' | 'rejected';
}

export interface CharacterSchedule {
  characterId: string;
  blocks: ScheduleBlock[];
  updatedAt: string;
}

export function emptySchedule(characterId: string): CharacterSchedule {
  return { characterId, blocks: [], updatedAt: new Date(0).toISOString() };
}

function blockKey(block: ScheduleBlock): string {
  return `${block.startHour}:${block.endHour}:${block.dayOfWeek ?? '*'}:${block.label}`;
}

/**
 * Merge incoming schedule blocks into an existing schedule.
 * Higher-confidence blocks override lower-confidence blocks at the same slot.
 * Expired blocks are dropped. Admin-rejected blocks are preserved (not overwritten).
 */
export function mergeSchedule(existing: CharacterSchedule, incoming: ScheduleBlock[], now = Date.now()): CharacterSchedule {
  const map = new Map<string, ScheduleBlock>();
  for (const block of existing.blocks) {
    if (block.expiresAt && Date.parse(block.expiresAt) <= now) continue;
    map.set(blockKey(block), block);
  }

  for (const block of incoming) {
    if (block.expiresAt && Date.parse(block.expiresAt) <= now) continue;
    const key = blockKey(block);
    const current = map.get(key);
    if (current?.adminStatus === 'rejected') continue;
    if (!current || block.confidence > current.confidence) {
      map.set(key, block);
    }
  }

  const blocks = [...map.values()].sort((a, b) => a.startHour - b.startHour || a.endHour - b.endHour);
  return { characterId: existing.characterId, blocks, updatedAt: new Date(now).toISOString() };
}

/**
 * Admin confirms or rejects a schedule block by id.
 * Returns updated schedule, or undefined if block not found.
 */
export function adminReviewBlock(
  schedule: CharacterSchedule,
  blockId: string,
  decision: 'approved' | 'rejected',
  now = Date.now(),
): CharacterSchedule | undefined {
  const index = schedule.blocks.findIndex((b) => b.id === blockId);
  if (index < 0) return undefined;
  const blocks = schedule.blocks.map((b, i) => i === index ? { ...b, adminStatus: decision } : b);
  return { ...schedule, blocks, updatedAt: new Date(now).toISOString() };
}

/** Return only blocks that are currently active (approved or pending, not expired). */
export function activeBlocks(schedule: CharacterSchedule, now = Date.now()): ScheduleBlock[] {
  return schedule.blocks.filter((b) => {
    if (b.adminStatus === 'rejected') return false;
    if (b.expiresAt && Date.parse(b.expiresAt) <= now) return false;
    return true;
  });
}
