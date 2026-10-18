import type { Logger } from '../core/logger.js';
import type { MemoryDeletionNotification, MemoryDeletionSink } from './deletion-coordinator.js';
import { SemanticMemoryGovernance } from './semantic-memory-governance.js';
import type { Storage } from '../storage/types.js';

export class SemanticDeletionSink implements MemoryDeletionSink {
  readonly name = 'semantic-memory';
  readonly #governance: SemanticMemoryGovernance;
  readonly #logger: Logger;
  constructor(options: { storage: Storage; logger: Logger }) {
    this.#governance = new SemanticMemoryGovernance(options.storage, options.logger);
    this.#logger = options.logger.child({ component: 'semantic-deletion-sink' });
  }
  async forgetSourceMessage(notification: MemoryDeletionNotification): Promise<void> {
    try {
      await this.#governance.forgetSourceMessage(notification);
    } catch (error) {
      this.#logger.warn({ botId: notification.botId, sourceMessageId: notification.sourceMessageId, error: error instanceof Error ? error.message : String(error) }, 'semantic deletion sink failed');
    }
  }
}
