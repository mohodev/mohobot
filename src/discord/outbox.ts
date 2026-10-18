import type { Storage } from '../storage/types.js';
import type { DeliveryResult } from './types.js';

export type DeliveryRecordStatus = 'sending' | 'delivered' | 'rejected' | 'unknown';

export interface DeliveryRecord {
  kind: 'discord-delivery';
  dedupeKey: string;
  botId: string;
  channelId: string;
  content: string;
  status: DeliveryRecordStatus;
  messageId?: string;
  error?: string;
  updatedAt: number;
}

const prefix = 'outbox:discord-delivery:';
const keyFor = (dedupeKey: string): string => `${prefix}${encodeURIComponent(dedupeKey)}`;

export class DiscordDeliveryOutbox {
  constructor(private readonly storage: Storage) {}

  async get(dedupeKey: string): Promise<DeliveryRecord | undefined> {
    const value = await this.storage.get<unknown>(keyFor(dedupeKey));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as DeliveryRecord : undefined;
  }

  async reserve(input: Omit<DeliveryRecord, 'kind' | 'status' | 'updatedAt'>): Promise<{ record: DeliveryRecord; reserved: boolean }> {
    const record: DeliveryRecord = { ...input, kind: 'discord-delivery', status: 'sending', updatedAt: Date.now() };
    if (!this.storage.compareAndSet) throw new Error('storage driver must support atomic compareAndSet');
    const previous = await this.get(input.dedupeKey);
    if (previous?.status === 'rejected') {
      const reserved = await this.storage.compareAndSet(keyFor(input.dedupeKey), previous, record);
      return { record: reserved ? record : (await this.get(input.dedupeKey)) ?? previous, reserved };
    }
    const reserved = await this.storage.compareAndSet(keyFor(input.dedupeKey), undefined, record);
    return { record: (reserved ? record : await this.get(input.dedupeKey)) ?? record, reserved };
  }

  async record(dedupeKey: string, result: DeliveryResult): Promise<DeliveryRecord> {
    const current = await this.get(dedupeKey);
    if (!current) throw new Error('delivery record not found');
    const next: DeliveryRecord = {
      ...current,
      status: result.status === 'delivered' ? 'delivered' : result.status,
      ...(result.messageId ? { messageId: result.messageId } : {}),
      ...(result.error ? { error: result.error } : {}),
      updatedAt: Date.now(),
    };
    await this.storage.save(keyFor(dedupeKey), next);
    return next;
  }
}
