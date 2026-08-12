// Copyright (c) 2024-2026 nich (@nichxbt). Business Source License 1.1.
/**
 * articleToMarkdown — turn a twitterArticleReadView DOM subtree into markdown.
 *
 * Replaces `readView.innerText`, which returns the rendered text of the article and
 * throws away every structural element that produced it. A heading, a list item and a
 * line of code all arrive as the same bare line, so an article that was written with
 * sections, steps and code blocks is stored as an undifferentiated wall of
 * paragraphs. Nothing downstream can recover the structure, because by then it is
 * genuinely gone: `innerText` is the lossy step, not the storage or the renderer.
 *
 * ## Why this function takes a DOM element and has no imports
 *
 * It runs in two places and must be the same code in both:
 *
 *   - production — puppeteer serialises it with `Function.prototype.toString` and
 *     evaluates it in the page over CDP, where the article's DOM actually exists.
 *     Serialisation is why it can reference NOTHING outside itself: no imports, no
 *     module-scope constants, no helpers defined next to it. Every helper is nested.
 *   - tests — jsdom builds the same subtree in Node and calls it directly.
 *
 * That is what makes it unit-testable without a live X session, and it is the same
 * split `extractArticleText` uses: keep the logic pure, keep the browser step dumb.
 * jsdom is a devDependency, so converting in Node instead would put a heavy parser
 * into the server's runtime just to re-parse HTML the browser had already parsed.
 *
 * ## What it does not do
 *
 * It emits markdown for the semantic elements an article is written with and treats
 * anything else as a container to descend into. An unknown wrapper therefore costs
 * nothing — its children are still reached — which matters because the read view is
 * an editor's output and its non-semantic wrappers are not ours to depend on.
 */

/**
 * @param {Element} [root]  the read view; defaults to querying for it (the
 *                          production call passes no arguments)
 * @returns {string} markdown, or '' when the read view is absent
 */
export function articleToMarkdown(root) {
  // The production call passes nothing and the page always has a `document`; a test
  // may pass a detached node, and Node has no global one to fall back to.
  const view = root || (typeof document === 'undefined' ? null
    : document.querySelector('[data-testid="twitterArticleReadView"]'));
  if (!view) return '';

  // Chrome that lives INSIDE the read view: the author row, the follow button, the
  // engagement counts. Dropped by identity here rather than by matching their text
  // downstream — `extractArticleText` had to guess from line shape, which is why a
  // bare `@handle` line could not be told apart from an embedded tweet's attribution.
  const SKIP_TESTID = ['User-Name', 'UserAvatar', 'caret', 'like', 'retweet', 'reply',
    'bookmark', 'app-text-transition-container'];
  const SKIP_TAG = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'BUTTON', 'INPUT', 'NAV'];

  const isSkipped = (el) => {
    if (SKIP_TAG.includes(el.tagName)) return true;
    const testid = el.getAttribute && el.getAttribute('data-testid');
    return !!testid && SKIP_TESTID.includes(testid);
  };

  // ---- inline -------------------------------------------------------------
  // Emphasis markers are only emitted around text that actually carries them, so a
  // `<strong>` wrapping whitespace cannot produce a stray `**` that markdown then
  // pairs with the next one and italicises half a paragraph.
  const wrap = (marker, inner) => {
    const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!m || !m[2]) return inner;
    // Nested spans can carry the same style twice; wrapping again would emit
    // ****text****, which renders as literal asterisks rather than emphasis.
    if (m[2].startsWith(marker) && m[2].endsWith(marker)) return inner;
    return m[1] + marker + m[2] + marker + m[3];
  };

  // Backslash-escape what would otherwise be read as markup. Deliberately narrow, and
  // `_` is deliberately NOT in it: identifiers like tool_use and auth_token are common
  // in these articles, intraword underscores are not emphasis in CommonMark, and the
  // escape is not free — the stored page is read by graders and greps as plain text,
  // where a phrase carrying `\_` no longer matches the phrase it came from.
  const escapeText = (text) => text.replace(/([\\`*[\]])/g, '\\$1');

  // DraftJS — which is what the read view is — carries bold and italic as inline
  // STYLE on a span, not as <strong>/<em>. 41 bold spans and 6 italic in one captured
  // article, all of which a tag-only rule silently drops. Read from the style
  // attribute rather than getComputedStyle so the same code works under jsdom, where
  // X's stylesheets are not loaded.
  const styleOf = (el) => (el.getAttribute && el.getAttribute('style')) || '';
  const isBold = (el) => /font-weight:\s*(bold|[6-9]00)/i.test(styleOf(el));
  const isItalic = (el) => /font-style:\s*italic/i.test(styleOf(el));

  const inline = (node) => {
    if (node.nodeType === 3) return escapeText(node.nodeValue);
    if (node.nodeType !== 1) return '';
    if (isSkipped(node)) return '';
    const tag = node.tagName;
    if (tag === 'BR') return '\n';
    if (tag === 'IMG') {
      const src = node.getAttribute('src') || '';
      const alt = node.getAttribute('alt') || '';
      return src ? `![${alt}](${src})` : '';
    }
    // Code is escaped by its own fence, so its text is taken raw — escaping inside a
    // span of code would put backslashes into the code itself.
    if (tag === 'CODE') {
      const raw = node.textContent || '';
      return raw ? '`' + raw.replace(/`/g, '') + '`' : '';
    }
    let inner = [...node.childNodes].map(inline).join('');
    if (tag === 'A') {
      const href = node.getAttribute('href') || '';
      const text = inner.trim();
      if (!text) return '';
      // X wraps an article image in a link to its own media permalink. Nesting the
      // image inside that link gains a reader nothing — the target is an X-internal
      // path — and costs the image, since the nested form is what renderers choke on.
      if (/^!\[[^\]]*\]\([^)]*\)$/.test(text)) return text;
      // A link whose text already IS its target reads as noise when doubled up.
      if (!href || href === text) return text;
      return `[${text}](${href})`;
    }
    // Style-carried emphasis is applied before the tag rules so a <strong> that also
    // carries `font-style: italic` gets both, and a plain span carrying either gets it
    // at all.
    if (isItalic(node)) inner = wrap('_', inner);
    if (isBold(node)) inner = wrap('**', inner);
    // `&& !isBold` so a <strong> that ALSO carries font-weight:bold — DraftJS emits
    // both — is not wrapped twice into ****text****.
    if ((tag === 'STRONG' || tag === 'B') && !isBold(node)) return wrap('**', inner);
    if ((tag === 'EM' || tag === 'I') && !isItalic(node)) return wrap('_', inner);
    if (tag === 'DEL' || tag === 'S') return wrap('~~', inner);
    return inner;
  };

  // ---- blocks -------------------------------------------------------------
  const BLOCK = ['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE',
    'HR', 'TABLE', 'FIGURE', 'FIGCAPTION'];

  const hasBlockChild = (el) =>
    [...el.children].some((c) => BLOCK.includes(c.tagName) && !isSkipped(c));

  const out = [];
  const push = (text) => { if (text && text.trim()) out.push(text.trim()); };

  const walk = (node, depth) => {
    if (node.nodeType === 3) {
      // Loose text directly under a container still counts as a paragraph — the read
      // view is not obliged to wrap everything.
      push(escapeText(node.nodeValue));
      return;
    }
    if (node.nodeType !== 1 || isSkipped(node)) return;
    const tag = node.tagName;

    if (/^H[1-6]$/.test(tag)) {
      push('#'.repeat(+tag[1]) + ' ' + inline(node).trim());
      return;
    }
    if (tag === 'PRE') {
      const code = node.querySelector('code');
      const cls = (code && code.getAttribute('class')) || node.getAttribute('class') || '';
      const lang = (cls.match(/(?:lang|language)-([\w+#-]+)/) || [])[1] || '';
      // textContent, not inline(): a fence's contents are literal, and running them
      // through the escaper would put backslashes into the code.
      const body = (code || node).textContent.replace(/\n+$/, '');
      push('```' + lang + '\n' + body + '\n```');
      return;
    }
    if (tag === 'HR') { push('---'); return; }
    if (tag === 'BLOCKQUOTE') {
      const inner = [];
      const save = out.length;
      [...node.childNodes].forEach((c) => walk(c, depth));
      while (out.length > save) inner.unshift(out.pop());
      push(inner.join('\n\n').split('\n').map((l) => ('> ' + l).trimEnd()).join('\n'));
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      const ordered = tag === 'OL';
      const start = +(node.getAttribute('start') || 1);
      let n = start;
      [...node.children].forEach((li) => {
        if (li.tagName !== 'LI' || isSkipped(li)) return;
        const marker = ordered ? `${n++}. ` : '- ';
        const pad = ' '.repeat(marker.length);
        // A nested list is a block child, so the item is walked rather than inlined —
        // its own lines come back and get indented under the marker.
        let body;
        if (hasBlockChild(li)) {
          const save = out.length;
          [...li.childNodes].forEach((c) => walk(c, depth + 1));
          const parts = [];
          while (out.length > save) parts.unshift(out.pop());
          body = parts.join('\n\n');
        } else {
          body = inline(li).trim();
        }
        if (!body) return;
        // Continuation lines are indented under the marker, but a BLANK one is left
        // bare: padding it emits trailing whitespace, which several renderers read as
        // a hard line break and every linter flags.
        const lines = body.split('\n');
        push(marker + lines[0]
          + lines.slice(1).map((l) => '\n' + (l ? pad + l : '')).join(''));
      });
      return;
    }
    // A container: descend. A leaf-ish block: emit its inline content as a paragraph.
    if (hasBlockChild(node)) {
      [...node.childNodes].forEach((c) => walk(c, depth));
      return;
    }
    push(inline(node));
  };

  walk(view, 0);
  // Collapse the runs of blank lines that nested containers leave behind.
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}
