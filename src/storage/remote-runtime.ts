import { randomUUID } from 'node:crypto';
import type { EventBus } from '../core/event.js';
import type { Logger } from '../core/logger.js';
import type { MohoMessageDelete, MohoMessageUpdate, MohoThreadLifecycle } from '../core/types.js';
import type { Storage } from './types.js';
import { Outbox } from './outbox.js';
import { RuntimeRemoteCoordinator } from './remote-coordinator.js';
import { createRemoteServices, type OptionalRemoteDrivers } from './remote-factory.js';
import type { RemoteStorageConfig } from './remote-config.js';

export interface RemoteRuntime {
  outbox: Outbox;
  coordinator: RuntimeRemoteCoordinator;
  stopEventBridge(): Promise<void>;
}

export interface CreateRemoteRuntimeOptions {
  config: RemoteStorageConfig;
  storage: Storage;
  events: EventBus;
  logger: Logger;
  /** Vendor drivers are supplied by the embedding application; none are imported here. */
  drivers?: OptionalRemoteDrivers;
}

function messagePayload(event: MohoMessageUpdate | MohoMessageDelete) {
  return {
    botId: event.botId,
    platform: event.platform,
    messageId: event.messageId,
    location: event.location,
    ...('editedAt' in event ? { editedAt: event.editedAt } : { deletedAt: event.deletedAt }),
    partial: event.partial,
  };
}

/**
 * Build the local Outbox, optional remote services and their lifecycle owner.
 * Event payloads are an explicit allowlist: config paths/errors and credentials
 * are never copied to the durable stream.
 */
export function createRemoteRuntime(options: CreateRemoteRuntimeOptions): RemoteRuntime {
  const outbox = new Outbox(options.storage);
  const services = createRemoteServices(options.config, options.drivers ?? {}, options.logger);
  // Constructor deliberately throws for remote-authoritative. There is no
  // local fallback in that mode: boot must fail closed.
  const coordinator = new RuntimeRemoteCoordinator({
    config: options.config,
    outbox,
    services,
    logger: options.logger,
  });
  const unsubscribers: Array<() => void> = [];
  const pending = new Set<Promise<unknown>>();
  const append = (type: string, eventId: string, payload: unknown) => {
    const operation = coordinator.append({ eventId, type, payload }).catch((error) => {
      options.logger.warn({ type, err: error instanceof Error ? error.message : String(error) }, 'outbox append failed');
    });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  };
  unsubscribers.push(
    options.events.on('message:update', (event) => append(
      'message.updated.v1',
      `message-update:${event.platform}:${event.botId}:${event.messageId}:${event.editedAt}`,
      messagePayload(event),
    )),
    options.events.on('message:delete', (event) => append(
      'message.deleted.v1',
      `message-delete:${event.platform}:${event.botId}:${event.messageId}:${event.deletedAt}`,
      messagePayload(event),
    )),
    options.events.on('thread:lifecycle', (event: MohoThreadLifecycle) => append(
      'thread.lifecycle.v1',
      `thread:${event.platform}:${event.botId}:${event.channelId}:${event.action}:${event.occurredAt}`,
      {
        botId: event.botId,
        platform: event.platform,
        action: event.action,
        channelId: event.channelId,
        parentChannelId: event.parentChannelId,
        guildId: event.guildId,
        forumPost: event.forumPost,
        archived: event.archived,
        locked: event.locked,
        partial: event.partial,
        occurredAt: event.occurredAt,
      },
    )),
    options.events.on('config:reload', () => append(
      'config.reloaded.v1',
      `config-reload:${randomUUID()}`,
      { occurredAt: Date.now(), outcome: 'accepted' },
    )),
    options.events.on('config:reload:failed', () => append(
      'config.reload-failed.v1',
      `config-reload-failed:${randomUUID()}`,
      { occurredAt: Date.now(), outcome: 'rejected' },
    )),
  );
  return {
    outbox,
    coordinator,
    async stopEventBridge() {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      await Promise.allSettled([...pending]);
    },
  };
}
