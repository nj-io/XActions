// Copyright (c) 2024-2026 nich (@nichxbt). Business Source License 1.1.
/**
 * Capture one article's read view as a test fixture.
 *
 * `articleToMarkdown` should be tested against markup X actually emits, not markup we
 * imagined it emits — an article read view is an editor's output and its element
 * choices are not ours to guess. This is the only step that needs a live session; once
 * the fixture is committed the walker's tests run offline forever.
 *
 *   XACTIONS_SESSION_COOKIE=<auth_token> node tests/capture-readview.mjs <url> <out-dir>
 */
import puppeteer from 'puppeteer';
import { promises as fs } from 'fs';
import path from 'path';
import { articleToMarkdown } from '../src/mcp/articleMarkdown.js';

const [url, outDir = 'tests/fixtures'] = process.argv.slice(2);
const cookie = process.env.XACTIONS_SESSION_COOKIE;
if (!url || !cookie) {
  console.error('usage: XACTIONS_SESSION_COOKIE=… node tests/capture-readview.mjs <url> [outDir]');
  process.exit(2);
}

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.setUserAgent(
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
await page.setCookie({
  name: 'auth_token', value: cookie, domain: '.x.com',
  path: '/', httpOnly: true, secure: true,
});

await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 4000));
// Same scroll loop the tool uses, so the fixture is the same DOM the tool would read.
for (let i = 0; i < 25; i++) {
  await page.evaluate(() => window.scrollBy(0, 800));
  await new Promise((r) => setTimeout(r, 500));
}

const html = await page.evaluate(() =>
  document.querySelector('[data-testid="twitterArticleReadView"]')?.outerHTML || '');
if (!html) {
  console.error('no readView — not logged in, or not an article URL');
  await browser.close();
  process.exit(1);
}
// The production path: puppeteer serialises the walker and runs it in the page.
const markdown = await page.evaluate(articleToMarkdown);
const text = await page.evaluate(() =>
  document.querySelector('[data-testid="twitterArticleReadView"]').innerText);
await browser.close();

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, 'article-readview.html'), html);
await fs.writeFile(path.join(outDir, 'article-readview.md'), markdown);
await fs.writeFile(path.join(outDir, 'article-readview.innertext.txt'), text);
console.log(JSON.stringify({
  html: html.length, markdown: markdown.length, innerText: text.length,
  headings: (markdown.match(/^#{1,6} /gm) || []).length,
  listItems: (markdown.match(/^\s*(?:[-*]|\d+\.) /gm) || []).length,
  codeFences: (markdown.match(/^```/gm) || []).length,
}, null, 2));
