/**
 * Reply artifact filter — strips markup artifacts from LLM replies that should
 * not be sent. Faithful port of upstream `mohobot/utils/reply_filter.py`
 * (behaviour design based on the 2026-10 production census: 7 days, 41,565
 * LLM-sent messages, ~6.4% affected). Three confirmed policies:
 *
 *  - VOICE (tts family incl. spelling variants and the （tts）paren form):
 *    strip the tag; the content is shown AND counted into the read-aloud text.
 *  - FORMAT (model-invented formatting/decoration tags: text/response/caps/
 *    b/call/p/q ...): strip the tag; the content is shown.
 *  - DROP (tool-call syntax blocks, think blocks, emoji/bbox code-ish tags):
 *    tag and inner content are discarded as a whole block.
 *
 * Recognition tolerance: case-insensitive classify; angle / square / 【】 /
 * paren tag families; optional leading `/`; known tag names may carry
 * attributes; an unknown pure angle tag is treated as FORMAT (strip tag, keep
 * content) so future artifacts self-heal; the square/【】/paren families only
 * react to VOICE aliases to avoid mangling quoted text like `[assistant]`;
 * word-boundary safe: `<ttsx>`/`<tts2>` are not misread as `<tts>`.
 *
 * Stream safety: a suspected tag start is held back for judgement (bounded
 * hold) and released verbatim when the judgement fails; unterminated voice
 * runs to the end (forgiving a forgotten close tag); unterminated drop runs to
 * the end (the leak is not shown); a tool-syntax block past the salvage cap is
 * released as body text so a malformed block cannot swallow the whole reply.
 */

export const VOICE_TAGS: ReadonlySet<string> = new Set([
  'tts', 'ts', 'voice', 'speech', 'say',
  'tt', 'ttt', 'tss', 'tgs', 'mts', 'is_tts', 'welcome_tts',
]);

export const FORMAT_TAGS: ReadonlySet<string> = new Set([
  'text', 'txt', 'response', 'caps', 'b', 'i', 's', 'e', 'em', 'u',
  'strong', 'bold', 'call', 'p', 'q', 'span', 'div', 'td', 'tr', 'th',
  'table', 'button', 'br', 'hr', 'font', 'snoring', 'cough', 'sigh',
  'envelope', 'message', 'tags',
]);

export const DROP_TAGS: ReadonlySet<string> = new Set([
  'tool_call', 'function', 'parameter', 'arg_key', 'arg_value',
  'description', 'search_meme', 'steal_meme', 'send_meme',
  'think', 'thinking', 'reasoning', 'consumed', 'eot',
  'emoji', 'bbox', 'ratio',
]);

export type TagKind = 'voice' | 'format' | 'drop';

/** Lowercase classify: voice alias → voice, drop name → drop, else format. */
export function classifyTag(name: string): TagKind {
  const n = name.toLowerCase();
  if (VOICE_TAGS.has(n)) return 'voice';
  if (DROP_TAGS.has(n)) return 'drop';
  return 'format';
}

/** Past this many buffered chars a tool-syntax drop block is released as text. */
const DROP_SALVAGE_CHARS = 2000;
/** Bounded streaming holds: long cap for `<...`, short cap for bracket/paren. */
const HOLD_CAP_ANGLE = 80;
const HOLD_CAP_SHORT = 14;

/** Drop names that are tool-call syntax; only those are salvage-eligible. */
const TOOL_SYNTAX_TAGS: ReadonlySet<string> = new Set([
  'tool_call', 'function', 'parameter', 'arg_key', 'arg_value',
  'description', 'search_meme', 'steal_meme', 'send_meme',
]);

const byLengthDesc = (a: string, b: string): number => b.length - a.length;
/** Longest-first so regex alternation prefers the longest alias. */
const VOICE_ALIAS_ALT = [...VOICE_TAGS].sort(byLengthDesc).join('|');
const DROP_TAG_ALT = [...DROP_TAGS].sort(byLengthDesc).join('|');

const ANGLE_ATTR_NAME = '[a-zA-Z_:][a-zA-Z0-9_.:-]*';
const ANGLE_ATTR_VALUE = '(?:"[^"]*"|\'[^\']*\'|[^\\s"\'<>]+)';
// Case-SENSITIVE like the Python original (compiled without re.IGNORECASE);
// the explicit [a-zA-Z] classes still match upper-case tag names and
// classifyTag() lowercases them, so `<TTS>` is still recognised as voice.
const ANGLE_TAG_RE = new RegExp(
  '<\\s*(/?)\\s*([a-zA-Z][a-zA-Z0-9_-]{0,18})' +
  '(?:\\s+' + ANGLE_ATTR_NAME + '\\s*=\\s*' + ANGLE_ATTR_VALUE + ')*\\s*/?>',
);
const ANGLE_DROP_TOKEN = '(?:' + ANGLE_ATTR_NAME + '\\s*=\\s*' + ANGLE_ATTR_VALUE + '|[^\\s"\'<>]+)';
// Lenient twin for drop tags (tolerates malformed/bare attribute tokens and a
// stray `=value` right after the name), case-insensitive like the original.
const ANGLE_DROP_ATTR_RE = new RegExp(
  '<\\s*(/?)\\s*(' + DROP_TAG_ALT + ')' +
  '(?=[\\s/>=])(?:\\s*=\\s*' + ANGLE_ATTR_VALUE + ')?' +
  '(?:\\s+' + ANGLE_DROP_TOKEN + ')*\\s*/?>',
  'i',
);
const BR_VOICE_RE = new RegExp('[\\[【]\\s*(/?)\\s*(' + VOICE_ALIAS_ALT + ')\\s*[\\]】]', 'i');
const PAR_VOICE_RE = new RegExp('[(（]\\s*(/?)\\s*(' + VOICE_ALIAS_ALT + ')\\s*[)）]', 'i');

/** Partial angle-tag tail worth holding at a stream boundary. */
const PARTIAL_ANGLE_TAIL_RE = /^<\s*\/?\s*[a-zA-Z]?[a-zA-Z0-9_-]{0,18}[\x20-\x7e]{0,80}$/;

/** True if `tail` holds a `>` outside quotes (attribute values may contain `>`). */
function hasUnquotedAngleClose(tail: string): boolean {
  let quote: string | null = null;
  for (const ch of tail) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return true;
  }
  return false;
}

type Mode = 'voice' | 'drop' | null;

interface TagMatch {
  index: number;
  end: number;
  closing: boolean;
  selfClosing: boolean;
  /** Raw tag name as written (case preserved); classifyTag() lowercases. */
  name: string;
  /** Bracket/paren matches are always voice aliases. */
  voiceForm: boolean;
}

export class ReplyArtifactFilter {
  private _buf = '';
  private _mode: Mode = null;
  private _dropName = '';
  private _dropStack: string[] = [];
  private _dropReturnMode: 'voice' | null = null;
  private _dropScanPos = 0;
  /** Closed voice spans, in order. */
  private _spans: string[] = [];
  /** Fragments of the currently open voice span. */
  private _curSpan: string[] = [];

  /** Append a stream chunk; returns the display text that is now safe to send. */
  feed(chunk: string): string {
    this._buf += chunk;
    return this._drain(false);
  }

  /** Flush the stream; returns [remaining display text, accumulated tts text]. */
  finish(): [display: string, tts: string] {
    const display = this._drain(true);
    const tts = this._spans.filter((s) => s.length > 0).join('\n');
    return [display, tts];
  }

  private _emit(text: string, out: string[]): void {
    out.push(text);
    if (this._mode === 'voice') this._curSpan.push(text);
  }

  private _closeSpan(): void {
    this._spans.push(this._curSpan.join(''));
    this._curSpan = [];
    this._mode = null;
  }

  private _enterDrop(name: string, returnMode: 'voice' | null): void {
    this._mode = 'drop';
    this._dropName = name;
    this._dropStack = [name];
    this._dropReturnMode = returnMode;
    this._dropScanPos = 0;
  }

  private _exitDrop(): void {
    this._mode = this._dropReturnMode;
    this._dropReturnMode = null;
    this._dropName = '';
    this._dropStack = [];
    this._dropScanPos = 0;
  }

  /**
   * Release an oversized tool-syntax block as body text instead of letting a
   * malformed block swallow the whole reply. Returns true when salvaged.
   */
  private _salvageIfOversized(out: string[]): boolean {
    if (this._buf.length <= DROP_SALVAGE_CHARS || !TOOL_SYNTAX_TAGS.has(this._dropName)) return false;
    out.push(this._buf);
    if (this._dropReturnMode === 'voice') this._curSpan.push(this._buf);
    this._buf = '';
    this._exitDrop();
    return true;
  }

  /**
   * Consume buffer content while inside a drop block. Returns true when the
   * main loop should continue (mode changed or the scan advanced), false when
   * the block is still open and we are waiting for more input.
   */
  private _drainDrop(final: boolean, out: string[]): boolean {
    const m = ANGLE_DROP_ATTR_RE.exec(this._buf.slice(this._dropScanPos));
    if (m) {
      const raw = m[0];
      const closing = m[1] === '/';
      const name = m[2]!.toLowerCase();
      const selfClosing = raw.endsWith('/>');
      const end = this._dropScanPos + m.index + raw.length;
      if (!closing && !selfClosing) {
        // nested drop tag opens one more level
        this._dropStack.push(name);
      } else if (closing) {
        // pop to the nearest same-name opener, inclusive; stray closers are ignored
        const idx = this._dropStack.lastIndexOf(name);
        if (idx >= 0) this._dropStack.length = idx;
      }
      this._dropScanPos = end;
      if (this._dropStack.length === 0) {
        // outermost drop block closed: discard everything up to here
        this._buf = this._buf.slice(end);
        this._exitDrop();
        return true;
      }
      this._salvageIfOversized(out);
      return true;
    }
    // no further drop token in the buffer
    if (this._salvageIfOversized(out)) return true;
    if (final) {
      // unterminated drop: discard to the end, the leak is not shown
      this._buf = '';
      this._exitDrop();
      return true;
    }
    return false;
  }

  /** Earliest tag match among the four families; angle wins on a tie. */
  private _nextTag(buf: string): TagMatch | null {
    let best: TagMatch | null = null;
    const consider = (re: RegExp, voiceForm: boolean): void => {
      const m = re.exec(buf);
      if (m === null) return;
      if (best !== null && m.index >= best.index) return;
      best = {
        index: m.index,
        end: m.index + m[0].length,
        closing: m[1] === '/',
        selfClosing: m[0].endsWith('/>'),
        name: m[2]!,
        voiceForm,
      };
    };
    consider(ANGLE_TAG_RE, false);
    consider(ANGLE_DROP_ATTR_RE, false);
    consider(BR_VOICE_RE, true);
    consider(PAR_VOICE_RE, true);
    return best;
  }

  private _handleTag(tag: TagMatch): void {
    const kind: TagKind = tag.voiceForm ? 'voice' : classifyTag(tag.name);

    if (this._mode === 'voice') {
      if (tag.voiceForm) {
        // Bracket/paren voice forms have no distinct close syntax; a second
        // marker toggles the current span shut (e.g. `(tts)hi(tts)`).
        this._closeSpan();
        return;
      }
      if (tag.closing) {
        // any voice close ends the span; stray format/drop closers are stripped
        if (kind === 'voice') this._closeSpan();
        return;
      }
      if (tag.selfClosing) return;
      if (kind === 'drop') {
        // a drop block inside a voice span: resume capturing when it ends
        this._enterDrop(tag.name.toLowerCase(), 'voice');
      }
      // nested voice/format openers inside voice are stripped, span stays open
      return;
    }

    // normal mode
    if (tag.closing || tag.selfClosing) return; // stray closer / self-contained: strip
    if (kind === 'voice') {
      this._mode = 'voice';
      this._curSpan = [];
    } else if (kind === 'drop') {
      this._enterDrop(tag.name.toLowerCase(), null);
    }
    // format (incl. unknown angle tags): strip the tag, keep the content
  }

  /**
   * Hold index for a suspected unfinished tag at the buffer tail, or null.
   * Scans right-to-left so the rightmost candidate holds; held text is
   * bounded by HOLD_CAP_ANGLE / HOLD_CAP_SHORT.
   */
  private _partialTailHold(buf: string, mode: Mode): number | null {
    if (mode === 'drop') return null;
    for (let i = buf.length - 1; i >= 0; i--) {
      const ch = buf[i];
      if (ch === '<') {
        const tail = buf.slice(i);
        if (tail.length > HOLD_CAP_ANGLE) continue;
        if (hasUnquotedAngleClose(tail.slice(1))) continue;
        if (PARTIAL_ANGLE_TAIL_RE.test(tail)) return i;
      } else if (ch === '[' || ch === '【' || ch === '(' || ch === '（') {
        const tail = buf.slice(i);
        if (tail.length > HOLD_CAP_SHORT) continue;
        let inner = tail.slice(1).replace(/\s+/g, '');
        if (inner.startsWith('/')) inner = inner.slice(1);
        const lowered = inner.toLowerCase();
        if (lowered === '' || [...VOICE_TAGS].some((alias) => alias.startsWith(lowered))) return i;
      }
    }
    return null;
  }

  private _drain(final: boolean): string {
    const out: string[] = [];
    for (;;) {
      if (this._mode === 'drop') {
        if (this._drainDrop(final, out)) continue;
        break;
      }
      const tag = this._nextTag(this._buf);
      if (tag !== null) {
        this._emit(this._buf.slice(0, tag.index), out);
        this._buf = this._buf.slice(tag.end);
        this._handleTag(tag);
        continue;
      }
      // no complete tag in the buffer
      if (final) {
        this._emit(this._buf, out);
        this._buf = '';
        // unterminated voice runs to the end: its content is shown and read
        if (this._mode === 'voice') this._closeSpan();
        break;
      }
      const hold = this._partialTailHold(this._buf, this._mode);
      if (hold !== null) {
        this._emit(this._buf.slice(0, hold), out);
        this._buf = this._buf.slice(hold);
      } else {
        this._emit(this._buf, out);
        this._buf = '';
      }
      break;
    }
    return out.join('');
  }
}

/** Non-streaming convenience: feed the whole text, then finish. */
export function stripReplyArtifacts(text: string): { display: string; tts: string } {
  const filter = new ReplyArtifactFilter();
  const head = filter.feed(text);
  const [rest, tts] = filter.finish();
  return { display: head + rest, tts };
}
