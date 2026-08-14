import { RECORD_TYPE_RULES } from './migrations.js';

export const CURRENT_RECORD_VERSION = 1;
export const CURRENT_WRITER_VERSION = 1;

export interface RecordMetadata {
  recordType: string | null;
  recordVersion: number | null;
  writerVersion: number | null;
}

export type RecordMetadataErrorCode =
  | 'record_type_mismatch'
  | 'future_record_version'
  | 'future_writer_version'
  | 'incomplete_record_metadata';

export class RecordMetadataError extends Error {
  constructor(readonly code: RecordMetadataErrorCode, readonly key: string, message: string) {
    super(message);
    this.name = 'RecordMetadataError';
  }
}

export function expectedRecordType(key: string): string | null {
  return RECORD_TYPE_RULES.find(([prefix]) => key.startsWith(prefix))?.[1] ?? null;
}

export function validateRecordMetadata(key: string, metadata: RecordMetadata): void {
  const expected = expectedRecordType(key);
  const { recordType, recordVersion, writerVersion } = metadata;
  const populated = recordType !== null || recordVersion !== null || writerVersion !== null;
  if (!populated && expected === null) return;
  if (recordType === null || recordVersion === null || writerVersion === null) {
    throw new RecordMetadataError('incomplete_record_metadata', key, `KV record ${key} has incomplete metadata`);
  }
  if (expected !== recordType) {
    throw new RecordMetadataError('record_type_mismatch', key, `KV record ${key} has type ${recordType}; expected ${expected ?? 'untyped'}`);
  }
  if (!Number.isSafeInteger(recordVersion) || recordVersion < 1 || recordVersion > CURRENT_RECORD_VERSION) {
    throw new RecordMetadataError('future_record_version', key, `KV record ${key} uses unsupported record version ${recordVersion}`);
  }
  if (!Number.isSafeInteger(writerVersion) || writerVersion < 1 || writerVersion > CURRENT_WRITER_VERSION) {
    throw new RecordMetadataError('future_writer_version', key, `KV record ${key} was written by unsupported writer version ${writerVersion}`);
  }
}
