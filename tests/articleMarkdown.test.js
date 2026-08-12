// Copyright (c) 2024-2026 nich (@nichxbt). Business Source License 1.1.
/**
 * articleToMarkdown Test Suite
 *
 * The function runs in the browser in production (puppeteer serialises it over CDP)
 * and under jsdom here. That is the point of it having no imports: these tests
 * exercise the very bytes that ship, not a Node-side reimplementation of them.
 *
 * What is being locked in is the difference between `innerText` and this: a heading,
 * a list item and a line of code must come out distinguishable. `innerText` returns
 * all three as bare lines, which is why one captured article carries 651 lines, one
 * heading, zero list items and zero code fences.
 */

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { articleToMarkdown } from '../src/mcp/articleMarkdown.js';

/** Build a read view around `html` and convert it. */
function md(html) {
  const dom = new JSDOM(
    `<div data-testid="twitterArticleReadView">${html}</div>`);
  return articleToMarkdown(
    dom.window.document.querySelector('[data-testid="twitterArticleReadView"]'));
}

describe('structure innerText destroys', () => {
  it('keeps heading levels', () => {
    expect(md('<h1>Title</h1><h2>Section</h2><h3>Sub</h3>'))
      .toBe('# Title\n\n## Section\n\n### Sub');
  });

  it('keeps an unordered list', () => {
    expect(md('<ul><li>first</li><li>second</li></ul>'))
      .toBe('- first\n\n- second');
  });

  it('numbers an ordered list, honouring start', () => {
    expect(md('<ol><li>one</li><li>two</li></ol>')).toBe('1. one\n\n2. two');
    expect(md('<ol start="3"><li>three</li></ol>')).toBe('3. three');
  });

  it('fences a code block and carries its language', () => {
    expect(md('<pre><code class="language-python">x = 1\ny = 2</code></pre>'))
      .toBe('```python\nx = 1\ny = 2\n```');
  });

  it('fences a code block with no language', () => {
    expect(md('<pre><code>plain</code></pre>')).toBe('```\nplain\n```');
  });

  it('marks a blockquote', () => {
    expect(md('<blockquote><p>quoted</p></blockquote>')).toBe('> quoted');
  });

  it('keeps a horizontal rule', () => {
    expect(md('<p>a</p><hr><p>b</p>')).toBe('a\n\n---\n\nb');
  });
});

describe('inline', () => {
  it('emits bold, italic and strikethrough', () => {
    expect(md('<p><strong>b</strong> <em>i</em> <del>d</del></p>'))
      .toBe('**b** _i_ ~~d~~');
  });

  it('keeps whitespace outside the emphasis markers', () => {
    // `** bold **` is not emphasis in most renderers — the markers must hug the text.
    expect(md('<p><strong> bold </strong>after</p>')).toBe('**bold** after');
  });

  it('does not emit markers around whitespace-only emphasis', () => {
    expect(md('<p>a<strong> </strong>b</p>')).toBe('a b');
  });

  it('writes links as markdown', () => {
    expect(md('<p><a href="https://e.com">text</a></p>'))
      .toBe('[text](https://e.com)');
  });

  it('does not double up a link whose text is its own target', () => {
    expect(md('<p><a href="https://e.com">https://e.com</a></p>'))
      .toBe('https://e.com');
  });

  it('keeps inline code raw, without escaping inside it', () => {
    expect(md('<p>call <code>a_b_c</code> now</p>')).toBe('call `a_b_c` now');
  });

  it('escapes markup characters in prose so a re-render is faithful', () => {
    expect(md('<p>a_b_c and *stars*</p>')).toBe('a\\_b\\_c and \\*stars\\*');
  });

  it('turns <br> into a line break inside a paragraph', () => {
    expect(md('<p>one<br>two</p>')).toBe('one\ntwo');
  });

  it('keeps images with their alt text', () => {
    expect(md('<p><img src="https://i/x.jpg" alt="a chart"></p>'))
      .toBe('![a chart](https://i/x.jpg)');
  });
});

describe('nesting', () => {
  it('indents a nested list under its parent item', () => {
    expect(md('<ul><li>outer<ul><li>inner</li></ul></li></ul>'))
      .toBe('- outer\n\n  - inner');
  });

  it('descends through non-semantic wrappers', () => {
    // The read view is an editor's output; its wrapper divs are not ours to depend on.
    expect(md('<div><div><div data-block="true"><h2>Deep</h2></div></div></div>'))
      .toBe('## Deep');
  });

  it('does not emit a container and its children twice', () => {
    expect(md('<div><p>only once</p></div>')).toBe('only once');
  });

  it('reads loose text that no element wraps', () => {
    expect(md('<div>bare text</div>')).toBe('bare text');
  });
});

describe('chrome inside the read view', () => {
  it('drops the author row rather than guessing from line shape', () => {
    const html = '<div data-testid="User-Name"><span>Ada</span>' +
      '<a href="/ada">@ada</a></div><p>The article body.</p>';
    expect(md(html)).toBe('The article body.');
  });

  it('drops buttons and svg', () => {
    expect(md('<button>Follow</button><svg><path/></svg><p>body</p>')).toBe('body');
  });

  it('keeps an embedded tweet card\'s attribution', () => {
    // The opposite case, and the reason chrome is dropped by identity: here the
    // handle IS the attribution for someone else's words. `extractArticleText` could
    // not tell the two apart, because by then both were bare lines.
    const html = '<p>As noted:</p><blockquote><p>@someone</p>' +
      '<p>their words</p></blockquote>';
    expect(md(html)).toContain('@someone');
  });
});

describe('shape', () => {
  it('returns empty string when there is no read view', () => {
    const dom = new JSDOM('<div>no article here</div>');
    expect(articleToMarkdown(
      dom.window.document.querySelector('[data-testid="twitterArticleReadView"]')))
      .toBe('');
  });

  it('collapses blank runs left by empty wrappers', () => {
    expect(md('<p>a</p><div></div><div>   </div><p>b</p>')).toBe('a\n\nb');
  });

  it('has no imports, so puppeteer can serialise it into the page', () => {
    const src = articleToMarkdown.toString();
    expect(src).not.toMatch(/\brequire\(|\bimport\b/);
    // Every helper must be nested: a reference to a module-scope binding would be
    // undefined once the function is evaluated in the browser.
    expect(src).toContain('const SKIP_TESTID');
    expect(src).toContain('const escapeText');
  });
});

describe('a real captured read view', () => {
  // tests/fixtures/article-readview.html is x.com/hooeem/status/2033198345045336559,
  // captured by tests/capture-readview.mjs. Authored fixtures prove the walker does
  // what I think X emits; this one proves it against what X actually emits.
  const fixture = resolve(__dirname, 'fixtures', 'article-readview.html');
  const dom = new JSDOM(readFileSync(fixture, 'utf-8'));
  const out = articleToMarkdown(
    dom.window.document.querySelector('[data-testid="twitterArticleReadView"]'));
  const innerText = readFileSync(
    resolve(__dirname, 'fixtures', 'article-readview.innertext.txt'), 'utf-8');

  it('recovers the structure innerText returns nothing of', () => {
    const count = (s, re) => (s.match(re) || []).length;
    const HEADING = /^#{1,6} /gm;
    const LIST = /^\s*(?:[-*]|\d+\.) /gm;
    const FENCE = /^```/gm;

    // What the flat capture yields, and why re-fetching through it changes nothing.
    expect(count(innerText, HEADING)).toBe(0);
    expect(count(innerText, LIST)).toBe(0);
    expect(count(innerText, FENCE)).toBe(0);

    expect(count(out, HEADING)).toBeGreaterThanOrEqual(6);
    expect(count(out, LIST)).toBeGreaterThanOrEqual(20);
    expect(count(out, FENCE) % 2).toBe(0);              // every fence closes
    expect(count(out, FENCE)).toBeGreaterThanOrEqual(12);
  });

  it('finds the section headings as headings', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(out).toMatch(new RegExp(`^## DOMAIN ${n}: `, 'm'));
    }
  });

  it('loses no words to the conversion', () => {
    // The guard the re-fetch is gated on: markdown ADDS markers, it never drops text.
    // Anything in the flat capture that is missing here is content the walk destroyed.
    const words = (s) => new Set(
      s.replace(/[\\`*_[\]()#>~-]/g, ' ').toLowerCase().match(/[a-z0-9]{4,}/g) || []);
    const lost = [...words(innerText)].filter((w) => !words(out).has(w));

    expect(lost).toEqual([]);
  });
});

describe('a whole article', () => {
  it('produces the structure the flat capture threw away', () => {
    const html = `
      <h1>I want to become a Claude architect</h1>
      <div data-block="true"><p>To become a Claude Architect you need to
      understand <strong>Claude Code</strong> and the Agent SDK.</p></div>
      <h2>DOMAIN 1: AGENTIC ARCHITECTURE</h2>
      <p>The exam tests three anti-patterns:</p>
      <ol><li>Parsing natural language to determine loop termination</li>
      <li>Arbitrary iteration caps</li></ol>
      <pre><code class="language-markdown">You are an expert instructor.</code></pre>
      <p>See <a href="https://docs.claude.com">the docs</a>.</p>`;

    expect(md(html)).toBe([
      '# I want to become a Claude architect',
      'To become a Claude Architect you need to\n      understand **Claude Code** and the Agent SDK.',
      '## DOMAIN 1: AGENTIC ARCHITECTURE',
      'The exam tests three anti-patterns:',
      '1. Parsing natural language to determine loop termination',
      '2. Arbitrary iteration caps',
      '```markdown\nYou are an expert instructor.\n```',
      'See [the docs](https://docs.claude.com).',
    ].join('\n\n'));
  });
});
