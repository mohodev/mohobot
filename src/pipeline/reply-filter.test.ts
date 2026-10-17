import { describe, expect, it } from 'vitest';
import { classifyTag, DROP_TAGS, FORMAT_TAGS, ReplyArtifactFilter, stripReplyArtifacts, VOICE_TAGS } from './reply-filter.js';

/** Feed chunks, then finish; returns joined display, tts, and per-feed emissions. */
function runChunks(chunks: string[]): { display: string; tts: string; emissions: string[] } {
  const filter = new ReplyArtifactFilter();
  const emissions = chunks.map((c) => filter.feed(c));
  const [rest, tts] = filter.finish();
  return { display: emissions.join('') + rest, tts, emissions };
}

describe('tag sets and classify', () => {
  it('exposes the upstream tag sets', () => {
    expect(VOICE_TAGS.has('tts')).toBe(true);
    expect(VOICE_TAGS.has('welcome_tts')).toBe(true);
    expect(FORMAT_TAGS.has('text')).toBe(true);
    expect(FORMAT_TAGS.has('response')).toBe(true);
    expect(DROP_TAGS.has('tool_call')).toBe(true);
    expect(DROP_TAGS.has('think')).toBe(true);
  });

  it('classifies case-insensitively, defaulting to format', () => {
    expect(classifyTag('TTS')).toBe('voice');
    expect(classifyTag('Think')).toBe('drop');
    expect(classifyTag('text')).toBe('format');
    expect(classifyTag('whatever-new')).toBe('format');
  });
});

describe('stripReplyArtifacts (non-streaming)', () => {
  it('strips FORMAT tags and keeps the content', () => {
    expect(stripReplyArtifacts('hello <text>world</text> !').display).toBe('hello world !');
  });

  it('drops think blocks wholesale', () => {
    expect(stripReplyArtifacts('a<think>secret</think>b').display).toBe('ab');
  });

  it('drops tool_call syntax blocks with attributes', () => {
    expect(stripReplyArtifacts('x<tool_call foo=bar>{...}</tool_call>y').display).toBe('xy');
  });

  it('captures angle voice tags into the tts text', () => {
    const { display, tts } = stripReplyArtifacts('a<tts>read me</tts>b');
    expect(display).toBe('aread meb');
    expect(tts).toBe('read me');
  });

  it('captures the square-bracket voice form', () => {
    const { display, tts } = stripReplyArtifacts('a[tts]hi[/tts]b');
    expect(display).toBe('ahib');
    expect(tts).toBe('hi');
  });

  it('captures the 【】 voice form', () => {
    const { display, tts } = stripReplyArtifacts('a【tts】hi【/tts】b');
    expect(display).toBe('ahib');
    expect(tts).toBe('hi');
  });

  it('captures the paren voice form, where a second marker toggles the span shut', () => {
    const { display, tts } = stripReplyArtifacts('a(tts)hi(tts)b');
    expect(display).toBe('ahib');
    expect(tts).toBe('hi');
  });

  it('treats unknown angle tags as FORMAT (self-heal)', () => {
    expect(stripReplyArtifacts('a<newtag>x</newtag>b').display).toBe('axb');
  });

  it('leaves comparison operators alone', () => {
    expect(stripReplyArtifacts('a < b && c > d').display).toBe('a < b && c > d');
    expect(stripReplyArtifacts('1 < 2 > 0').display).toBe('1 < 2 > 0');
  });

  it('is word-boundary safe around tts lookalikes', () => {
    // unknown angle tags self-heal as format: tag stripped, content kept
    expect(stripReplyArtifacts('<ttsx>keep</ttsx>').display).toBe('keep');
    expect(stripReplyArtifacts('<tts2>keep</tts2>').display).toBe('keep');
    // bracket families only react to exact voice aliases: left untouched
    expect(stripReplyArtifacts('[ttsx]keep[/ttsx]').display).toBe('[ttsx]keep[/ttsx]');
  });

  it('handles upper-case angle VOICE tags (name classes match A-Z, classify lowercases)', () => {
    const { display, tts } = stripReplyArtifacts('<TTS>hi</TTS>');
    expect(display).toBe('hi');
    expect(tts).toBe('hi');
  });

  it('drops upper-case angle DROP tags (drop regex is case-insensitive)', () => {
    expect(stripReplyArtifacts('<THINK>secret</THINK>').display).toBe('');
  });

  it('runs unterminated voice to the end and reads it', () => {
    const { display, tts } = stripReplyArtifacts('a<tts>forgot to close');
    expect(display).toBe('aforgot to close');
    expect(tts).toBe('forgot to close');
  });

  it('discards an unterminated drop block to the end', () => {
    expect(stripReplyArtifacts('a<tool_call>leak').display).toBe('a');
  });

  it('handles nested drop blocks', () => {
    expect(stripReplyArtifacts('a<think>x<think>y</think>z</think>b').display).toBe('ab');
  });

  it('salvages an oversized unterminated tool-syntax block as body text', () => {
    const filler = 'x'.repeat(2100);
    const { display } = stripReplyArtifacts(`a<tool_call>${filler}`);
    expect(display).toBe(`a${filler}`);
  });

  it('does not salvage oversized think blocks (they stay dropped)', () => {
    const filler = 'x'.repeat(2100);
    expect(stripReplyArtifacts(`a<think>${filler}`).display).toBe('a');
  });

  it('keeps attributes on known tags', () => {
    const { display, tts } = stripReplyArtifacts('<tts lang="en">hi</tts>');
    expect(display).toBe('hi');
    expect(tts).toBe('hi');
  });

  it('handles > inside quoted attribute values', () => {
    expect(stripReplyArtifacts('a<think data="a>b">s</think>x').display).toBe('ax');
  });

  it('strips self-closing tags', () => {
    expect(stripReplyArtifacts('a<br/>b').display).toBe('ab');
    expect(stripReplyArtifacts('a<tts/>b').display).toBe('ab');
  });

  it('omits empty voice spans from the tts text', () => {
    const { display, tts } = stripReplyArtifacts('a<tts></tts>b');
    expect(display).toBe('ab');
    expect(tts).toBe('');
  });

  it('resumes voice capture after a drop block inside a voice span', () => {
    const { display, tts } = stripReplyArtifacts('<tts>hi<think>x</think>there</tts>');
    expect(display).toBe('hithere');
    expect(tts).toBe('hithere');
  });
});

describe('ReplyArtifactFilter streaming', () => {
  it('never leaks a partial drop tag across chunk boundaries', () => {
    const filter = new ReplyArtifactFilter();
    expect(filter.feed('a<th')).toBe('a');
    expect(filter.feed('ink>x</thi')).toBe('');
    expect(filter.feed('nk>b')).toBe('b');
    const [rest, tts] = filter.finish();
    expect(rest).toBe('');
    expect(tts).toBe('');
  });

  it('matches the non-streaming result when fed char by char', () => {
    const text = 'Hi <tts>read this</tts> mid <think>gone</think>end < b && <newtag>ok</newtag> [tts]bye[/tts]';
    const expected = stripReplyArtifacts(text);
    const { display, tts, emissions } = runChunks([...text]);
    expect(display).toBe(expected.display);
    expect(tts).toBe(expected.tts);
    // no partial tag ever leaks mid-stream (the '< b &&' comparison text is
    // released verbatim once it is judged not to be a tag, and that is fine)
    expect(emissions.every((e) => !/<\/?[a-zA-Z]/.test(e) && !e.includes('[tts'))).toBe(true);
  });

  it('holds a bracket voice prefix at the stream boundary without leaking it', () => {
    const filter = new ReplyArtifactFilter();
    expect(filter.feed('a[tt')).toBe('a');
    expect(filter.feed('s]hi[/tts]b')).toBe('hib');
    const [rest] = filter.finish();
    expect(rest).toBe('');
  });

  it('releases a held tail verbatim when it turns out not to be a tag', () => {
    const filter = new ReplyArtifactFilter();
    expect(filter.feed('a <t')).toBe('a ');
    expect(filter.feed(' not a tag')).toBe('');
    const [rest] = filter.finish();
    expect(rest).toBe('<t not a tag');
  });

  it('accumulates multiple voice spans in order at finish()', () => {
    const filter = new ReplyArtifactFilter();
    filter.feed('x<tts>one</tts>y[tts]two[/tts]z');
    const [rest, tts] = filter.finish();
    expect(rest).toBe('');
    expect(tts).toBe('one\ntwo');
  });
});

describe('stripReplyArtifacts matches the class', () => {
  it('equals feed()+finish() for a mixed string', () => {
    const text = 'pre <tts>say it</tts> <think>hide</think> mid <newtag>fmt</newtag> [tts]tail[/tts] end';
    const filter = new ReplyArtifactFilter();
    const head = filter.feed(text);
    const [rest, tts] = filter.finish();
    expect(stripReplyArtifacts(text)).toEqual({ display: head + rest, tts });
    expect(stripReplyArtifacts(text).display).toBe('pre say it  mid fmt tail end');
    expect(stripReplyArtifacts(text).tts).toBe('say it\ntail');
  });
});
