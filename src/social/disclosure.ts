import crypto from 'node:crypto';
import type { AIProvider } from '../ai/types.js';
import type { Storage } from '../storage/types.js';

export type MemoryScope = 'private' | 'relationship' | 'shared';
export interface SocialDisclosure {
  requesterCharacterId: string;
  subjectUserId: string;
  targetCharacterId: string;
  scope: MemoryScope;
  requesterAffinity: number;
  targetAffinity: number;
  targetAllowsPeerConsultation: boolean;
  hasDirectMessageChannel: boolean;
}

/**
 * Gate for character-to-character consultation. It deliberately authorizes
 * only abstract, shared facts; private transcript, diary and relationship
 * notes never become eligible for automatic disclosure.
 */
export function mayConsultPeer(input: SocialDisclosure): boolean {
  if (input.requesterCharacterId === input.targetCharacterId) return false;
  if (input.scope !== 'shared') return false;
  if (!input.targetAllowsPeerConsultation || !input.hasDirectMessageChannel) return false;
  return input.requesterAffinity >= 70 && input.targetAffinity >= 70;
}

// ---------------------------------------------------------------------------
// Consult request / result types
// ---------------------------------------------------------------------------

export interface ConsultRequest {
  gate: SocialDisclosure;
  /** Abstract shared-scope facts the requester wants to ask about. */
  sharedFacts: string[];
  /** Short topic label for the consultation (stored in audit). */
  topic: string;
}

export type ConsultOutcome = 'answered' | 'gate_denied' | 'error';

export interface ConsultResult {
  outcome: ConsultOutcome;
  /** Abstract answer from the target character (only when outcome is 'answered'). */
  answer?: string;
  /** Human-readable reason when outcome is not 'answered'. */
  reason?: string;
  auditId?: string;
}

// ---------------------------------------------------------------------------
// Disclosure audit
// ---------------------------------------------------------------------------

export interface DisclosureAuditEntry {
  id: string;
  at: string;
  requesterCharacterId: string;
  targetCharacterId: string;
  subjectUserId: string;
  topic: string;
  gateResult: boolean;
  outcome: ConsultOutcome;
  /** Short summary of the answer or denial reason — never full transcript. */
  summary: string;
}

const AUDIT_PREFIX = 'disclosure-audit:';
const SUMMARY_MAX = 200;
const ANSWER_MAX = 1_000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// Prompt construction — only shared-scope facts, never private data
// ---------------------------------------------------------------------------

const CONSULT_SYSTEM =
  'You are answering a character-to-character peer consultation. ' +
  'The requester has shared-scope facts about a user and is asking ' +
  'for your perspective. Respond abstractly and briefly. ' +
  'Do not reference private chat transcripts, diary entries, ' +
  'relationship notes, or any data outside the shared facts provided. ' +
  'Keep your answer under 300 words.';

function buildConsultPrompt(request: ConsultRequest): string {
  const facts = request.sharedFacts.map((f, i) => `${i + 1}. ${f}`).join('\n');
  return (
    `Topic: ${request.topic}\n\n` +
    `Shared facts about user ${request.gate.subjectUserId}:\n${facts}\n\n` +
    `Please provide your perspective on this topic based only on the shared facts above.`
  );
}

/** Validate that a prompt does not contain obviously private material. */
export function promptIsSafe(prompt: string): boolean {
  const forbidden = [
    /\btranscript\b/i,
    /\bdiary\b/i,
    /\brelationship\s*notes?\b/i,
    /\bprivate\s+(chat|message|dm|log)\b/i,
  ];
  return !forbidden.some((re) => re.test(prompt));
}

// ---------------------------------------------------------------------------
// Core consultation function
// ---------------------------------------------------------------------------

export async function consultPeer(
  request: ConsultRequest,
  deps: { provider: AIProvider; storage: Storage },
): Promise<ConsultResult> {
  const gateResult = mayConsultPeer(request.gate);

  if (!gateResult) {
    const reason = gateReason(request.gate);
    const entry = auditEntry(request, false, 'gate_denied', reason);
    await saveAudit(deps.storage, entry).catch(() => {});
    return { outcome: 'gate_denied', reason, auditId: entry.id };
  }

  try {
    const userPrompt = buildConsultPrompt(request);
    if (!promptIsSafe(userPrompt)) {
      const reason = 'prompt contains forbidden private material';
      const entry = auditEntry(request, true, 'error', reason);
      await saveAudit(deps.storage, entry).catch(() => {});
      return { outcome: 'error', reason, auditId: entry.id };
    }

    const response = await deps.provider.chat(
      [
        { role: 'system', content: CONSULT_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      { task: 'admin', temperature: 0.4, timeoutMs: 15_000 },
    );

    const answer = truncate((response.content ?? '').trim(), ANSWER_MAX);
    const summary = truncate(answer, SUMMARY_MAX);
    const entry = auditEntry(request, true, 'answered', summary);
    await saveAudit(deps.storage, entry).catch(() => {});
    return { outcome: 'answered', answer, auditId: entry.id };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const entry = auditEntry(request, true, 'error', truncate(reason, SUMMARY_MAX));
    await saveAudit(deps.storage, entry).catch(() => {});
    return { outcome: 'error', reason, auditId: entry.id };
  }
}

// ---------------------------------------------------------------------------
// Audit persistence
// ---------------------------------------------------------------------------

function auditEntry(
  request: ConsultRequest,
  gateResult: boolean,
  outcome: ConsultOutcome,
  summary: string,
): DisclosureAuditEntry {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    at: new Date(now).toISOString(),
    requesterCharacterId: request.gate.requesterCharacterId,
    targetCharacterId: request.gate.targetCharacterId,
    subjectUserId: request.gate.subjectUserId,
    topic: truncate(request.topic, SUMMARY_MAX),
    gateResult,
    outcome,
    summary: truncate(summary, SUMMARY_MAX),
  };
}

async function saveAudit(storage: Storage, entry: DisclosureAuditEntry): Promise<void> {
  const ts = new Date(entry.at).getTime();
  await storage.save(`${AUDIT_PREFIX}${String(ts).padStart(16, '0')}:${entry.id}`, entry);
}

export async function listAudits(
  storage: Storage,
  botId?: string,
  limit = 50,
): Promise<DisclosureAuditEntry[]> {
  const cap = Math.min(200, Math.max(1, limit));
  const rows = await storage.query<DisclosureAuditEntry>({ prefix: AUDIT_PREFIX, limit: cap });
  return rows
    .filter((r) => {
      if (!r.value || typeof r.value !== 'object') return false;
      if (botId && r.value.requesterCharacterId !== botId && r.value.targetCharacterId !== botId) return false;
      return true;
    })
    .map((r) => r.value);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gateReason(gate: SocialDisclosure): string {
  if (gate.requesterCharacterId === gate.targetCharacterId) return 'cannot consult self';
  if (gate.scope !== 'shared') return 'only shared scope is permitted';
  if (!gate.targetAllowsPeerConsultation) return 'target has not opted in to peer consultation';
  if (!gate.hasDirectMessageChannel) return 'no direct message channel available';
  if (gate.requesterAffinity < 70) return 'requester affinity too low';
  if (gate.targetAffinity < 70) return 'target affinity too low';
  return 'gate check failed';
}
