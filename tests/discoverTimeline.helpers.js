// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Shared fixtures for the timeline-discovery tests: a mocked logged-in
 * Puppeteer page that answers the GraphQL calls `discoverLikes`,
 * `discoverBookmarks` and `listBookmarkFolders` make, built from the real
 * (trimmed, redacted) X responses in tests/fixtures/x-timelines/.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = (name) =>
  JSON.parse(readFileSync(join(here, 'fixtures/x-timelines', `${name}.json`), 'utf8'));

/** The tweet entries (not cursors) of a timeline fixture. */
export function tweetEntries(json, path) {
  let node = json;
  for (const k of path) node = node[k];
  return node.timeline.instructions.flatMap((i) => i.entries || [])
    .filter((e) => e.entryId.startsWith('tweet-'));
}

export function cursorEntry(value) {
  return { entryId: `cursor-bottom-${value}`, content: { entryType: 'TimelineTimelineCursor', value } };
}

/** A likes timeline page (`data.user.result.timeline.timeline.instructions`). */
export function likesPage(entries, cursor) {
  const all = cursor ? [...entries, cursorEntry(cursor)] : entries;
  return { data: { user: { result: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: all }] } } } } } };
}

/** TweetDetail response holding one focal tweet result, or no entries. */
export function detailFor(result) {
  const entries = result
    ? [{ entryId: `tweet-${result.rest_id}`, content: { itemContent: { tweet_results: { result } } } }]
    : [];
  return { data: { threaded_conversation_with_injections_v2: { instructions: [{ entries }] } } };
}

/**
 * A mocked page.
 *
 * `pages(cursor, url)` returns `{json, status?}` for a timeline request. It
 * serves both the pre-refactor likes call (evaluate arg `{userId, cursor}`,
 * returns parsed JSON) and the resolver-built call (evaluate arg `{url}`,
 * returns `{status, text}`), so one test pins both builds.
 */
export function mockPage({ pages, tweets = {}, userId = '42' }) {
  const log = { timeline: [], detail: [] };
  const page = {
    url: () => 'https://x.com/home',
    goto: async () => {},
    reload: async () => {},
    evaluate: async (_fn, ...args) => {
      if (args.length === 3) return { ok: true, rest_id: userId, queryId: args[2][0] };
      const a = args[0];
      if (typeof a === 'string') {
        log.detail.push(a);
        return detailFor(tweets[a]);
      }
      if (a && 'userId' in a) {
        log.timeline.push({ legacy: true, cursor: a.cursor ?? null });
        return pages(a.cursor ?? null, null).json;
      }
      if (a && a.url) {
        const u = new URL(a.url);
        const v = JSON.parse(u.searchParams.get('variables'));
        log.timeline.push({ url: a.url, cursor: v.cursor ?? null, variables: v });
        const p = pages(v.cursor ?? null, u);
        return { status: p.status ?? 200, text: typeof p.json === 'string' ? p.json : JSON.stringify(p.json) };
      }
      throw new Error(`unexpected evaluate args ${JSON.stringify(args).slice(0, 200)}`);
    },
  };
  return { page, log };
}

/** Run a promise to completion while fake timers fast-forward every delay. */
export async function drain(promise) {
  let done = false;
  let value;
  let error;
  promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  // Fire only timers that exist, so the fake clock moves by the delays the
  // code asked for and nothing else; real I/O settles between turns.
  while (!done) {
    if (vi.getTimerCount() > 0) await vi.runOnlyPendingTimersAsync();
    else await new Promise((r) => setImmediate(r));
  }
  if (error) throw error;
  return value;
}
