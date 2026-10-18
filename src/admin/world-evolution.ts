import type { WorldState } from './world.js';
import type { ScheduledWorldEvent, ScheduledEventKind } from './world-events.js';

export interface MoodDelta { energy?: number; stress?: number; sociability?: number; curiosity?: number; }

export interface EvolutionRule {
  location?: string;
  activity?: string;
  mood: MoodDelta;
}

export type EvolutionPhase = 'start' | 'middle' | 'end';

const EVENT_RULES: Record<ScheduledEventKind, Record<EvolutionPhase, EvolutionRule>> = {
  concert: {
    start:  { mood: { energy: -0.12, stress: 0.08 } },
    middle: { mood: { energy: -0.12, stress: -0.03, sociability: 0.06 } },
    end:    { mood: { energy: -0.08, stress: -0.03 } },
  },
  trip: {
    start:  { mood: { energy: -0.05, curiosity: 0.04 } },
    middle: { mood: { energy: -0.05, curiosity: 0.02 } },
    end:    { mood: { energy: -0.05, stress: 0.03 } },
  },
  rehearsal: {
    start:  { mood: { energy: -0.08, stress: 0.05 } },
    middle: { mood: { energy: -0.10, stress: 0.02 } },
    end:    { mood: { energy: -0.06, stress: -0.02 } },
  },
  rest: {
    start:  { mood: { energy: 0.10, stress: -0.08 } },
    middle: { mood: { energy: 0.12, stress: -0.10 } },
    end:    { mood: { energy: 0.06, stress: -0.05 } },
  },
  news: {
    start:  { mood: { curiosity: 0.05 } },
    middle: { mood: { curiosity: 0.03 } },
    end:    { mood: {} },
  },
};

function clamp(n: number): number { return Math.max(0, Math.min(1, n)); }

function applyMoodDelta(mood: Record<string, number>, delta: MoodDelta): Record<string, number> {
  const result = { ...mood };
  for (const [key, value] of Object.entries(delta)) {
    if (typeof value === 'number') result[key] = clamp((result[key] ?? 0.5) + value);
  }
  return result;
}

export function evolutionRuleFor(kind: ScheduledEventKind, phase: EvolutionPhase): EvolutionRule {
  return EVENT_RULES[kind]?.[phase] ?? { mood: {} };
}

export interface EvolutionResult {
  applied: boolean;
  phaseKey: string;
  moodBefore: Record<string, number>;
  moodAfter: Record<string, number>;
}

/**
 * Apply confirmed-event state evolution to world state.
 * Returns a new state with mood changes applied and the phase key recorded.
 * Skips if the phase key is already in `appliedPhases` (idempotent).
 */
export function evolveWorld(
  state: WorldState,
  event: ScheduledWorldEvent,
  phase: EvolutionPhase,
): { state: WorldState; result: EvolutionResult } {
  const phaseKey = `${event.id}:${phase}`;
  const moodBefore = { ...state.mood };

  if (state.appliedPhases.includes(phaseKey)) {
    return {
      state,
      result: { applied: false, phaseKey, moodBefore, moodAfter: moodBefore },
    };
  }

  const rule = evolutionRuleFor(event.kind, phase);
  const moodAfter = applyMoodDelta(state.mood, rule.mood);

  const updated: WorldState = {
    ...state,
    mood: moodAfter,
    location: rule.location ?? event.location,
    appliedPhases: [...state.appliedPhases, phaseKey].slice(-1000),
  };

  return {
    state: updated,
    result: { applied: true, phaseKey, moodBefore, moodAfter },
  };
}
