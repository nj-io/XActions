// Copyright (c) 2024-2026 nich (@nichxbt). Business Source License 1.1.
/**
 * extractArticleText Test Suite
 *
 * Locks the header/footer boundary heuristic that x_read_article uses to turn a
 * twitterArticleReadView innerText dump into a verbatim article body. The logic
 * used to live inside a puppeteer page.evaluate (untestable); it now lives in a
 * pure module (src/mcp/articleText.js) so the >100-char header heuristic can be
 * improved later without silently changing behavior.
 *
 * The fixture (tests/fixtures/article-raw-innertext.txt) models the real
 * readView.innerText structure: a short header (title / author / @handle / ·
 * timestamp / engagement counts / "Views"), the body, then a trailing author
 * footer (name / @handle / "Following" / bio). A `## `-prefixed line sits inside
 * the body on purpose — article bodies legitimately contain them and the
 * stripper must NOT treat them as boundaries.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { extractArticleText } from '../src/mcp/articleText.js';

const RAW = readFileSync(
  resolve(__dirname, 'fixtures', 'article-raw-innertext.txt'),
  'utf-8',
);
const AUTHOR_NAME = 'Ada Lovelace';
const AUTHOR_HANDLE = 'adalovelace';

const EXPECTED = [
  'On-device inference has quietly crossed a threshold that changes the calculus for every mobile product team shipping machine learning today.',
  'The old assumption was that anything interesting had to run in the cloud. That assumption is now wrong for a large and growing class of models.',
  '## Why latency wins',
  'When the model runs locally, the round-trip to a datacenter disappears, and with it the tail-latency spikes that wreck perceived quality.',
  'This is the whole game for interactive experiences: predictable sub-100ms responses that never depend on a flaky network connection.',
].join('\n');

describe('extractArticleText', () => {
  const out = extractArticleText(RAW, AUTHOR_NAME, AUTHOR_HANDLE);

  it('strips the header — result starts at the first long content paragraph, not the title', () => {
    expect(out.startsWith('On-device inference has quietly crossed')).toBe(true);
    expect(out.startsWith('The Future of On-Device AI')).toBe(false);
    // none of the header lines survive as standalone lines
    const lines = out.split('\n');
    expect(lines).not.toContain('@adalovelace');
    expect(lines).not.toContain('·');
    expect(lines).not.toContain('Views');
  });

  it('strips the trailing author footer (name / @handle / Following / bio)', () => {
    expect(out.endsWith('flaky network connection.')).toBe(true);
    const lines = out.split('\n');
    expect(lines).not.toContain('Following');
    expect(lines).not.toContain('Ada Lovelace');
    expect(out).not.toContain('Writing about compute, latency, and the edge.');
  });

  it('preserves a ## -prefixed line inside the body (not a boundary)', () => {
    expect(out).toContain('## Why latency wins');
  });

  it('matches the locked verbatim body exactly', () => {
    expect(out).toBe(EXPECTED);
  });

  it('keeps all body when no footer markers fall inside the last-10-line window', () => {
    // Body long enough that the author markers (in the header) sit OUTSIDE the
    // footer scan window, and no footer marker is present near the end → no-op.
    const noFooter = [
      'Title Line',
      'Someone',
      '@someone',
      'This paragraph is deliberately much longer than one hundred characters so that the header heuristic treats it as the first real content line here.',
      'Second paragraph continues the article.',
      'Third.', 'Fourth.', 'Fifth.', 'Sixth.', 'Seventh.', 'Eighth.', 'Ninth.', 'Tenth.',
      'The final paragraph carries on without any trailing author footer to strip away at the end.',
    ].join('\n');
    const r = extractArticleText(noFooter, 'Someone', 'someone');
    expect(r.startsWith('This paragraph is deliberately')).toBe(true);
    expect(r.endsWith('at the end.')).toBe(true);
  });

  it('with no >100-char content line, keeps startIdx=0 and still trims footer markers', () => {
    const shortOnly = ['Title', 'Author', '@author'].join('\n');
    const r = extractArticleText(shortOnly, 'Author', 'author');
    // startIdx stays 0 (no long line); footer scan removes the 'Author'/'@author'
    // markers, leaving just the first line.
    expect(r).toBe('Title');
  });
});
