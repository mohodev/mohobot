import { createHash } from 'node:crypto';
import { buildInternalGuildPlan, type GuildInventory, type GuildPlan } from '../discord/guild-admin.js';

export function inventoryDigest(inventory: GuildInventory): string {
  const stable = {
    guildId: inventory.guildId,
    name: inventory.name,
    ownerId: inventory.ownerId,
    communityEnabled: inventory.communityEnabled,
    channels: [...inventory.channels].sort((a, b) => a.id.localeCompare(b.id)),
    roles: [...inventory.roles].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export interface GuildPlanAdapter {
  inventory(botId: string, guildId: string): Promise<GuildInventory>;
  apply(botId: string, plan: GuildPlan): Promise<{ applied: number; skipped: number; results?: Array<{ index: number; status: 'applied' | 'skipped' | 'failed'; error?: string }> }>;
}

export class GuildPlanner {
  readonly #adapter: GuildPlanAdapter;
  readonly #completed = new Map<string, Promise<unknown>>();

  constructor(adapter: GuildPlanAdapter) { this.#adapter = adapter; }

  async inventory(botId: string, guildId: string) {
    const inventory = await this.#adapter.inventory(botId, guildId);
    return { inventory, digest: inventoryDigest(inventory) };
  }

  async plan(botId: string, guildId: string) {
    const { inventory, digest } = await this.inventory(botId, guildId);
    return { plan: buildInternalGuildPlan(inventory), inventoryDigest: digest };
  }

  async apply(botId: string, plan: GuildPlan, expectedDigest: string, idempotencyKey: string) {
    if (!idempotencyKey || idempotencyKey.length > 128) throw new Error('invalid idempotency key');
    const allowed = new Set(['create-category', 'create-text', 'create-voice', 'move-channel', 'set-topic']);
    if (!plan || plan.communityEnabled !== false || !Array.isArray(plan.actions) || plan.actions.length > 100 || plan.actions.some((action) => !allowed.has(action.kind))) {
      throw new Error('guild plan contains an invalid or forbidden action');
    }
    const key = `${botId}:${plan.guildId}:${idempotencyKey}`;
    const prior = this.#completed.get(key);
    if (prior) return { ...(await prior as object), idempotent: true };
    const pending = (async () => {
      const current = await this.inventory(botId, plan.guildId);
      if (current.digest !== expectedDigest) throw new Error('guild inventory changed; create a new plan');
      const result = await this.#adapter.apply(botId, plan);
      return { ...result, inventoryDigest: current.digest, idempotent: false };
    })();
    this.#completed.set(key, pending);
    try { return await pending; }
    catch (error) { this.#completed.delete(key); throw error; }
  }
}
