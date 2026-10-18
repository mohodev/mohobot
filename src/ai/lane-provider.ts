import type { ChatMessage } from '../core/types.js';
import { TaskLane, type TaskLanePolicy, type TaskLaneType } from './model-operations.js';
import type { AIProvider, AIResponse, ChatOptions } from './types.js';
import { recordModelOperationEvent } from './model-operations.js';

export interface TaskLaneConfig {
  enabled?: boolean;
  policies?: Partial<Record<TaskLaneType, TaskLanePolicy>>;
}

function laneFor(options: ChatOptions): TaskLaneType {
  if (options.tools && options.tools.length > 0) return 'tool-call';
  if (options.task === 'planner') return 'planner';
  if (options.task === 'admin' || options.task === 'operator') return 'operator';
  return 'chat';
}

/** Adds optional lane model selection while leaving the provider contract intact. */
export class LaneProvider implements AIProvider {
  readonly #inner: AIProvider;
  readonly #lanes?: TaskLane;
  readonly #enabled: boolean;

  constructor(inner: AIProvider, config: unknown, snapshots: () => import('../bot/runtime.js').BotSnapshot[]) {
    this.#inner = inner;
    const value = config && typeof config === 'object' ? config as TaskLaneConfig : {};
    this.#enabled = value.enabled === true;
    this.#lanes = this.#enabled ? new TaskLane({ snapshots, policies: value.policies }) : undefined;
  }

  get name(): string { return this.#inner.name; }
  get model(): string { return this.#inner.model; }
  health(): Promise<{ ok: boolean; detail?: string }> { return this.#inner.health(); }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<AIResponse> {
    if (!this.#lanes) return this.#inner.chat(messages, options);
    const lane = laneFor(options);
    const assignment = this.#lanes.assignModel(lane, options.model);
    const selected = assignment?.modelId;
    if (!selected) return this.#inner.chat(messages, options);
    if (selected !== options.model) {
      recordModelOperationEvent({ kind: 'lane', lane, model: selected, detail: `${assignment!.source} model selected` });
    }
    return this.#inner.chat(messages, { ...options, model: selected, task: lane === 'chat' ? 'reply' : lane });
  }
}
