import type {
  AbEvaluationOutcome,
  AbEvaluateOptions,
  AbSide,
  AbVote,
  PersonaAbRecord,
  PersonaAbStats,
  PersonaSnapshot,
} from './persona-ab.js';

/** The slice of the usage recorder the pipeline needs. */
export interface UsageBridge {
  report(days: number): Promise<string>;
  /** Per-session (group/DM) ranking, busiest first. */
  sessionReport(days: number): Promise<string>;
}

/** The slice of the song library the pipeline needs. */
export interface SongBridge {
  /** Returns the 【歌曲信息】 block for chat text, or undefined. Never throws. */
  match(text: string): Promise<string | undefined>;
  status(): Promise<{ songs: number; updatedAt: number; syncing: boolean }>;
  /** Starts a background sync; completion is reported to the channel. */
  startSync(channelId: string): Promise<{ accepted: boolean; message: string }>;
}

/** The slice of the broadcast manager the pipeline needs. */
export interface BroadcastBridge {
  preview(content: string, authorId: string): Promise<string>;
  confirm(): Promise<string>;
  cancel(): Promise<string>;
}

/** The slice of the emotion manager the pipeline needs. */
export interface EmotionBridge {
  buildContextBlock(userKey: string): Promise<string>;
  scheduleTurn(userKey: string, userText: string, aiReply: string): void;
  getSnapshot(userKey: string): Promise<{
    userKey: string; favor: number; intimacy: number; stageName: string; stageDescription: string;
    compositeScore: number; progressToNext: number; nextStageName: string; nextStageThreshold: number | null;
    dominantMood: string; attitude: string; relationship: string;
    interactions: { total: number; positive: number; negative: number; positiveRatio: number };
    advice: string;
  }>;
  ranking(limit: number, direction: 'top' | 'bottom'): Promise<Array<{ userKey: string; averageScore: number; favor: number; intimacy: number; stage: string }>>;
  setFavor(userKey: string, value: number): void;
  setIntimacy(userKey: string, value: number): void;
}

/**
 * The slice of the persona A/B service the pipeline needs. The concrete
 * PersonaAbService satisfies this structurally; tests inject fakes.
 */
export interface PersonaAbBridge {
  reserve(input: {
    userId: string;
    sourceMessageId: string;
    contextSide: AbSide;
    baseline: PersonaSnapshot;
    test: PersonaSnapshot;
  }): Promise<PersonaAbRecord | null>;
  evaluate(
    record: PersonaAbRecord,
    generate: (personaContent: string) => Promise<string>,
    opts?: AbEvaluateOptions,
  ): Promise<AbEvaluationOutcome>;
  snapshot(side: AbSide, fallbackContent: string, fallbackLabel: string): Promise<PersonaSnapshot>;
  preference(userId: string): Promise<AbSide | null>;
  loadVotable(userId: string, identifier?: string): Promise<PersonaAbRecord | null>;
  vote(userId: string, identifier: string | undefined, choice: AbVote): Promise<PersonaAbRecord>;
  switchPersona(userId: string, identifier: string, choice: 'A' | 'B'): Promise<PersonaAbRecord>;
  stats(): Promise<PersonaAbStats>;
}
