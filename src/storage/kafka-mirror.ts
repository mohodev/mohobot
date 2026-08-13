import type { Logger } from '../core/logger.js';
import type { OutboxEvent } from './outbox.js';
import type { RemoteMirror } from './outbox-worker.js';

export interface KafkaMessage {
  key: string;
  value: string;
  headers?: Record<string, string>;
}

/** Minimal producer contract implemented by KafkaJS, proxies, and test doubles. */
export interface KafkaProducerLike {
  connect?(): Promise<void>;
  send(input: { topic: string; messages: KafkaMessage[] }): Promise<unknown>;
  health?(): Promise<boolean>;
  disconnect?(): Promise<void>;
}

export interface KafkaMirrorOptions {
  /** Static application prefix. Event data can only select a sanitized suffix. */
  topicPrefix?: string;
  schemaVersion?: number;
  maxPayloadBytes?: number;
}

export interface KafkaEnvelope<T = unknown> {
  schemaVersion: number;
  type: string;
  createdAt: number;
  payload: T;
}

export interface KafkaMirrorHealth {
  ok: boolean;
  connected: boolean;
  closed: boolean;
  lastError?: string;
}

const DEFAULT_TOPIC_PREFIX = 'mohobot.events';
const DEFAULT_SCHEMA_VERSION = 1;
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_EVENT_ID_LENGTH = 256;

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function validateTopicPrefix(value: string): string {
  const prefix = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,198}$/.test(prefix)) {
    throw new Error('invalid Kafka topic prefix');
  }
  return prefix;
}

function topicSuffix(type: string): string {
  const normalized = type
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 48);
  if (!normalized) throw new Error('outbox event type cannot form a Kafka topic');
  return normalized;
}

function serializePayload(payload: unknown, maxPayloadBytes: number): string {
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch (error) {
    throw new Error(`Kafka payload is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (json === undefined) throw new Error('Kafka payload is not JSON serializable');
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > maxPayloadBytes) {
    throw new Error(`Kafka payload exceeds ${maxPayloadBytes} bytes`);
  }
  return json;
}

/**
 * Optional Kafka publisher for the storage outbox.
 *
 * It owns no Kafka client dependency. A configured integration injects a
 * producer, while the default runtime simply never constructs this mirror.
 */
export class KafkaRemoteMirror implements RemoteMirror {
  readonly #producer: KafkaProducerLike;
  readonly #logger: Logger;
  readonly #topicPrefix: string;
  readonly #schemaVersion: number;
  readonly #maxPayloadBytes: number;
  #connectPromise?: Promise<void>;
  #connected = false;
  #closed = false;
  #lastError?: string;

  constructor(producer: KafkaProducerLike, logger: Logger, options: KafkaMirrorOptions = {}) {
    this.#producer = producer;
    this.#logger = logger.child({ component: 'kafka-mirror' });
    this.#topicPrefix = validateTopicPrefix(options.topicPrefix ?? DEFAULT_TOPIC_PREFIX);
    this.#schemaVersion = positiveInt(options.schemaVersion, DEFAULT_SCHEMA_VERSION);
    this.#maxPayloadBytes = positiveInt(options.maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES);
  }

  async send(event: OutboxEvent): Promise<void> {
    if (this.#closed) throw new Error('Kafka mirror is closed');
    const eventId = event.eventId.trim();
    if (!eventId || eventId.length > MAX_EVENT_ID_LENGTH) throw new Error('invalid Kafka event key');
    if (!event.type.trim()) throw new Error('Kafka event type is required');
    if (!Number.isFinite(event.createdAt) || event.createdAt < 0) throw new Error('invalid Kafka event createdAt');

    // Validate the payload itself before building the envelope. This makes the
    // configured limit independent from event metadata and schema overhead.
    serializePayload(event.payload, this.#maxPayloadBytes);
    const envelope: KafkaEnvelope = {
      schemaVersion: this.#schemaVersion,
      type: event.type,
      createdAt: event.createdAt,
      payload: event.payload,
    };
    const value = JSON.stringify(envelope);
    const topic = `${this.#topicPrefix}.${topicSuffix(event.type)}`;

    try {
      await this.#connect();
      await this.#producer.send({
        topic,
        messages: [{
          key: eventId,
          value,
          headers: {
            'content-type': 'application/json',
            'schema-version': String(this.#schemaVersion),
          },
        }],
      });
      this.#lastError = undefined;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#logger.warn({ eventId, type: event.type, err: error }, 'Kafka mirror publish failed');
      throw error;
    }
  }

  async health(): Promise<KafkaMirrorHealth> {
    if (this.#closed) return { ok: false, connected: false, closed: true, lastError: this.#lastError };
    try {
      const producerOk = this.#producer.health ? await this.#producer.health() : true;
      return {
        ok: producerOk && (this.#producer.connect === undefined || this.#connected),
        connected: this.#connected,
        closed: false,
        ...(this.#lastError ? { lastError: this.#lastError } : {}),
      };
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      return { ok: false, connected: this.#connected, closed: false, lastError: this.#lastError };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#connectPromise?.catch(() => {});
    if (this.#connected && this.#producer.disconnect) await this.#producer.disconnect();
    this.#connected = false;
  }

  async #connect(): Promise<void> {
    if (this.#connected || !this.#producer.connect) {
      this.#connected = true;
      return;
    }
    this.#connectPromise ??= this.#producer.connect().then(() => { this.#connected = true; });
    try {
      await this.#connectPromise;
    } catch (error) {
      this.#connectPromise = undefined;
      throw error;
    }
  }
}
