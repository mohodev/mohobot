export type ProvenanceSource = 'user' | 'ocr' | 'vlm' | 'mcp' | 'tool' | 'memory';

export interface Provenance {
  readonly source: ProvenanceSource;
  readonly trust: 'untrusted';
  readonly capturedAt?: number;
  readonly reference?: string;
}

export interface ProvenancedData<T> {
  readonly value: T;
  readonly provenance: Provenance;
}

const SECRET_LIKE = /(?:\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|bearer)\s*[:=]\s*[^\s,;]+|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/giu;

export function createProvenance(source: ProvenanceSource, options: { capturedAt?: number; reference?: string } = {}): Provenance {
  return {
    source,
    trust: 'untrusted',
    ...(options.capturedAt !== undefined ? { capturedAt: options.capturedAt } : {}),
    ...(options.reference !== undefined ? { reference: options.reference } : {}),
  };
}

export function withProvenance<T>(value: T, provenance: Provenance): ProvenancedData<T> {
  return { value, provenance };
}

export function hasSecretLikeContent(text: string): boolean {
  SECRET_LIKE.lastIndex = 0;
  return SECRET_LIKE.test(text);
}

export function redactUntrustedText(text: string): string {
  SECRET_LIKE.lastIndex = 0;
  return text.replace(SECRET_LIKE, '[REDACTED]');
}

export function safeProvenanceSummary(provenance: Provenance): string {
  return JSON.stringify({ source: provenance.source, trust: provenance.trust,
    ...(provenance.capturedAt !== undefined ? { capturedAt: provenance.capturedAt } : {}),
    ...(provenance.reference !== undefined ? { reference: redactUntrustedText(provenance.reference).slice(0, 128) } : {}) });
}
