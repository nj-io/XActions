// Copyright (c) 2024-2026 nich (@nichxbt). Business Source License 1.1.
/**
 * Emit the markdown for a saved read-view fixture. Offline — no session, no network.
 *   node tests/emit-markdown.mjs [fixture.html] [out.md]
 */
import { JSDOM } from 'jsdom';
import { readFileSync, writeFileSync } from 'fs';
import { articleToMarkdown } from '../src/mcp/articleMarkdown.js';

const [inPath = 'tests/fixtures/article-readview.html', outPath = '-'] =
  process.argv.slice(2);
const dom = new JSDOM(readFileSync(inPath, 'utf-8'));
const md = articleToMarkdown(
  dom.window.document.querySelector('[data-testid="twitterArticleReadView"]'));

if (outPath === '-') process.stdout.write(md);
else writeFileSync(outPath, md);

const count = (re) => (md.match(re) || []).length;
console.error(JSON.stringify({
  chars: md.length,
  headings: count(/^#{1,6} /gm),
  listItems: count(/^\s*(?:[-*]|\d+\.) /gm),
  codeBlocks: count(/^```/gm) / 2,
  bold: count(/\*\*/g) / 2,
  images: count(/^!\[/gm),
  strayUnderscoreEscapes: count(/\\_/g),
}, null, 2));
