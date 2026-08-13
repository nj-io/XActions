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
    expect(md('<p>see *stars* and [brackets]</p>'))
      .toBe('see \\*stars\\* and \\[brackets\\]');
  });

  it('leaves underscores alone — they are not emphasis inside a word', () => {
    // These articles are full of tool_use and auth_token. The escape is not free:
    // the stored page is read by graders and greps as plain text, where `tool\_use`
    // no longer matches the phrase it came from.
    expect(md('<p>pass tool_use to auth_token</p>')).toBe('pass tool_use to auth_token');
  });

  it('turns <br> into a line break inside a paragraph', () => {
    expect(md('<p>one<br>two</p>')).toBe('one\ntwo');
  });

  it('keeps images with their alt text', () => {
    expect(md('<p><img src="https://i/x.jpg" alt="a chart"></p>'))
      .toBe('![a chart](https://i/x.jpg)');
  });

  it('unwraps an image from the media permalink X wraps it in', () => {
    // The link target is an X-internal path, worth nothing to a reader, and the
    // nested `[![alt](src)](href)` form is what renderers choke on.
    expect(md('<a href="/who/article/1/media/2"><img src="https://i/x.jpg" alt="Image">'
      + '</a>')).toBe('![Image](https://i/x.jpg)');
  });
});

describe('emphasis carried as inline style (DraftJS)', () => {
  // The read view is a DraftJS document: bold and italic are a style attribute on a
  // span, never <strong>/<em>. A tag-only rule dropped 41 bold runs and 6 italic ones
  // from a single captured article without any signal that it had.
  it('reads bold from font-weight', () => {
    expect(md('<p><span style="font-weight: bold;">Agent SDK</span> matters</p>'))
      .toBe('**Agent SDK** matters');
  });

  it('reads bold from a numeric weight', () => {
    expect(md('<p><span style="font-weight: 700">heavy</span></p>')).toBe('**heavy**');
    expect(md('<p><span style="font-weight: 400">normal</span></p>')).toBe('normal');
  });

  it('reads italic from font-style', () => {
    expect(md('<p><span style="font-style: italic;">emphasis</span></p>'))
      .toBe('_emphasis_');
  });

  it('applies both when a span carries both', () => {
    expect(md('<p><span style="font-weight:bold;font-style:italic">x</span></p>'))
      .toBe('**_x_**');
  });

  it('does not double-wrap a tag that also carries the style', () => {
    expect(md('<p><strong style="font-weight: bold;">once</strong></p>'))
      .toBe('**once**');
  });

  it('does not double-wrap nested spans of the same style', () => {
    expect(md('<p><span style="font-weight:bold"><span style="font-weight:bold">'
      + 'x</span></span></p>')).toBe('**x**');
  });

  it('keeps the markers hugging the text through the DraftJS span nesting', () => {
    // The real shape: styled span wrapping a data-text span.
    const html = '<p><span style="font-weight: bold;"><span data-text="true">'
      + 'Customer Support Resolution Agent</span></span>'
      + '<span><span data-text="true"> (Agent SDK + MCP)</span></span></p>';
    expect(md(html)).toBe('**Customer Support Resolution Agent** (Agent SDK + MCP)');
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

describe('chrome the read view renders around the article', () => {
  /** A read view whose article content is DraftJS, with X's own UI around it. */
  function withHeader(headerHtml, bodyHtml) {
    const dom = new JSDOM('<div data-testid="twitterArticleReadView">'
      + headerHtml
      + `<div data-offset-key="abc-0-0">${bodyHtml}</div></div>`);
    return articleToMarkdown(
      dom.window.document.querySelector('[data-testid="twitterArticleReadView"]'));
  }

  it('drops the byline, which carries no testid to match on', () => {
    const header = '<a href="/hooeem"><span>hoeem</span></a>'
      + '<a href="/hooeem"><span>@hooeem</span></a><span>Mar 15</span>';
    expect(withHeader(header, '<p>The article body.</p>')).toBe('The article body.');
  });

  it('drops a hidden element', () => {
    // innerText excludes these by definition — it returns RENDERED text. A DOM walk
    // does not, which is how the Follow button's a11y label became a paragraph.
    const header = '<div style="display: none;">Click to Follow hooeem</div>'
      + '<div aria-hidden="true">·</div><div hidden>1.2K</div>';
    expect(withHeader(header, '<p>Body.</p>')).toBe('Body.');
  });

  it('drops a hidden element INSIDE the article too', () => {
    expect(withHeader('', '<p>Body.</p><p style="visibility:hidden">ghost</p>'))
      .toBe('Body.');
  });

  it('drops the author avatar but keeps article media', () => {
    const header = '<img src="https://pbs.twimg.com/profile_images/1/x_normal.jpg">';
    expect(withHeader(header, '<p><img src="https://pbs.twimg.com/media/a.jpg" '
      + 'alt="chart"></p>')).toBe('![chart](https://pbs.twimg.com/media/a.jpg)');
  });

  it('falls back to the whole view when there is no DraftJS content', () => {
    // Not every read view need be an editor document, and emitting nothing would be a
    // far worse failure than keeping a byline.
    const dom = new JSDOM('<div data-testid="twitterArticleReadView">'
      + '<p>Plain article.</p></div>');
    expect(articleToMarkdown(
      dom.window.document.querySelector('[data-testid="twitterArticleReadView"]')))
      .toBe('Plain article.');
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

  it('recovers the emphasis the fixture carries as inline style', () => {
    const styled = readFileSync(fixture, 'utf-8');
    const bold = (styled.match(/font-weight:\s*bold/gi) || []).length;
    expect(bold).toBeGreaterThanOrEqual(40);          // 41 in this capture

    // Every list item in this section leads with a bold term; innerText has none.
    expect(out).toContain('**Customer Support Resolution Agent** (Agent SDK');
    expect(out).toContain('**Code Generation with Claude Code** (CLAUDE.md');
    expect((out.match(/\*\*/g) || []).length).toBeGreaterThanOrEqual(60);
    // innerText's only `**` are glob patterns the author typed (`**/*.test.tsx`) —
    // literal content, not emphasis. It marks none of the 41 bold runs.
    expect(innerText).not.toContain('**Customer Support Resolution Agent');
  });

  it('leaves no stray escape in the prose a grader will grep', () => {
    expect(out).not.toContain('\\_');
    expect(out).toContain('tool_use');
  });

  it('unwraps an article image out of the media permalink', () => {
    expect(out).toMatch(/^!\[Image\]\(https:\/\/pbs\.twimg\.com\//m);
    expect(out).not.toMatch(/\[!\[/);
  });

  it('carries none of the byline the read view renders above the article', () => {
    // This fixture is a capture WITH the header present — the same article gave
    // markup without one on an earlier fetch, which is why the first batch shipped
    // the byline onto all 44 pages before anyone saw it rendered.
    for (const chrome of ['Click to Follow', 'profile_images', '@hooeem', 'Mar 15']) {
      expect(out).not.toContain(chrome);
    }
    // ...and innerText never had the hidden one, because it returns rendered text.
    expect(innerText).not.toContain('Click to Follow');
  });

  it('loses no word of the article BODY, only the chrome at its two ends', () => {
    // The property the corpus re-fetch is gated on, stated correctly. Markdown adds
    // markers and never drops text — but the walk also drops X's chrome by design, so
    // "loses nothing" is false and was the wrong invariant to assert. What must hold
    // is that every dropped word comes from the header or the footer: the title and
    // byline above the article, the author's bio below it. A word missing from the
    // MIDDLE is content the walk destroyed, and there must be none.
    const words = (s) => new Set(
      s.replace(/[\\`*_[\]()#>~-]/g, ' ').toLowerCase().match(/[a-z0-9]{4,}/g) || []);
    const lost = [...words(innerText)].filter((w) => !words(out).has(w));
    const EDGE = 300;

    expect(lost.length).toBeGreaterThan(0);      // there IS chrome in this fixture
    const interior = lost.filter((w) => {
      const lower = innerText.toLowerCase();
      for (let i = lower.indexOf(w); i !== -1; i = lower.indexOf(w, i + 1)) {
        if (i > EDGE && i < innerText.length - EDGE) return true;
      }
      return false;
    });
    expect(interior).toEqual([]);
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
