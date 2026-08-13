#!/usr/bin/env node
// Copyright (c) 2024-2026 nich (@nichxbt). Business Source License 1.1.
/**
 * Re-fetch a batch of X Articles as markdown.
 *
 * One browser and one login for the whole batch, rather than a session per article:
 * at ~30s of scroll-and-settle each, the setup cost is the batch, not the fetch.
 *
 * RESUMABLE. An article whose output already exists is skipped, so an interrupted run
 * is restarted by running it again — which matters when a full corpus pass is 40+
 * minutes of live session and X can rate-limit at any point in it.
 *
 * Writes markdown only. Applying it to a corpus — and deciding whether a replacement
 * is safe — is the caller's business, and deliberately not this script's.
 *
 *   XACTIONS_SESSION_COOKIE=<auth_token> \
 *     node bin/refetch-articles.mjs <worklist.json> <out-dir> [--limit N]
 *
 * worklist.json: [{ slug, articles: [{ article_id, url, title }] }]
 * output:        <out-dir>/<slug>__<article_id>.md   (+ .json sidecar with metrics)
 */
import puppeteer from 'puppeteer';
import { promises as fs } from 'fs';
import path from 'path';
import { articleToMarkdown } from '../src/mcp/articleMarkdown.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const [worklistPath, outDir] = args.filter((a) => !a.startsWith('--')
  && args[args.indexOf(a) - 1] !== '--limit');
const limit = Number(flag('--limit', Infinity));
const cookie = process.env.XACTIONS_SESSION_COOKIE;

if (!worklistPath || !outDir || !cookie) {
  console.error('usage: XACTIONS_SESSION_COOKIE=… node bin/refetch-articles.mjs '
    + '<worklist.json> <out-dir> [--limit N]');
  process.exit(2);
}

const worklist = JSON.parse(await fs.readFile(worklistPath, 'utf-8'));
await fs.mkdir(outDir, { recursive: true });

// Flatten to one job per ARTICLE: a page can carry more than one (its own, and one in
// a quoted post), and each is fetched from its own url.
const jobs = [];
for (const page of worklist) {
  for (const article of page.articles || []) {
    jobs.push({ slug: page.slug, ...article });
  }
}

const todo = [];
for (const job of jobs) {
  const out = path.join(outDir, `${job.slug}__${job.article_id}.md`);
  try {
    await fs.access(out);
  } catch {
    todo.push({ ...job, out });
  }
}
console.error(`${jobs.length} article(s); ${jobs.length - todo.length} already fetched; `
  + `${Math.min(todo.length, limit)} to do this run`);

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

let done = 0; let failed = 0;
for (const job of todo.slice(0, limit)) {
  try {
    await page.goto(job.url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 4000));
    for (let i = 0; i < 25; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await new Promise((r) => setTimeout(r, 500));
    }
    const present = await page.evaluate(() =>
      !!document.querySelector('[data-testid="twitterArticleReadView"]'));
    if (!present) {
      // No read view: deleted, gated, or a rate limit. Write NOTHING — an empty file
      // would be indistinguishable from a fetched-and-empty article on the next run,
      // and the resume check is existence.
      console.error(`  MISS  ${job.slug} — no readView (${job.url})`);
      failed += 1;
      continue;
    }
    let markdown = await page.evaluate(articleToMarkdown);
    // The title lives in the read view's HEADER, beside the byline, so scoping the
    // walk to the article's own DraftJS content correctly drops it along with the
    // author row. It is real content though, so it is put back explicitly from its
    // own element — not left to whatever the header happened to render.
    const title = await page.evaluate(() =>
      document.querySelector('[data-testid="twitter-article-title"]')
        ?.textContent?.trim() || '');
    if (title && !markdown.startsWith('#')) markdown = `# ${title}\n\n${markdown}`;
    const innerText = await page.evaluate(() =>
      document.querySelector('[data-testid="twitterArticleReadView"]').innerText);
    const exhausted = await page.evaluate(() =>
      (window.scrollY + window.innerHeight) >= document.scrollingElement.scrollHeight);
    if (!markdown) {
      console.error(`  MISS  ${job.slug} — read view produced no markdown`);
      failed += 1;
      continue;
    }
    await fs.writeFile(job.out, markdown);
    await fs.writeFile(job.out.replace(/\.md$/, '.json'), JSON.stringify({
      slug: job.slug,
      article_id: job.article_id,
      url: job.url,
      title: job.title,
      chars: markdown.length,
      innerTextChars: innerText.length,
      // Truncation is the scroll loop hitting its cap with page left — recorded so a
      // short article is never mistaken for a complete one downstream.
      truncated: !exhausted,
      headings: (markdown.match(/^#{1,6} /gm) || []).length,
      listItems: (markdown.match(/^\s*(?:[-*]|\d+\.) /gm) || []).length,
      codeBlocks: (markdown.match(/^```/gm) || []).length / 2,
      bold: (markdown.match(/\*\*/g) || []).length / 2,
      images: (markdown.match(/^!\[/gm) || []).length,
    }, null, 2) + '\n');
    done += 1;
    console.error(`  ok    ${job.slug} — ${markdown.length} chars`
      + `${exhausted ? '' : ' TRUNCATED'}`);
  } catch (e) {
    console.error(`  FAIL  ${job.slug} — ${e.message}`);
    failed += 1;
  }
}

await browser.close();
console.error(`\nfetched ${done}, failed ${failed}`);
process.exit(failed && !done ? 1 : 0);
