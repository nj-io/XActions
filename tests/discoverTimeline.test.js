// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Timeline discovery: the resolver-built likes, bookmarks and bookmark-folder
 * requests, the list-then-read loop and its options (skipIds, maxDeep,
 * exportDir), listingComplete, and the folder-not-found error.
 *
 * Responses are the real (trimmed, redacted) X bodies the 2026-10-19 probe
 * captured from a logged-in page: tests/fixtures/x-timelines/.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, tweetEntries, likesPage, mockPage, drain } from './discoverTimeline.helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const scraper = () => import('../src/scrapers/twitter/index.js');

const BOOKMARKS = fixture('BookmarkTimeline');
const FOLDER = fixture('BookmarkFolderTimeline');
const SLICE = fixture('BookmarkFoldersSlice');
const FOLDER_ID = '2023272167308476678';

const bookmarkEntries = tweetEntries(BOOKMARKS, ['data', 'bookmark_timeline_v2']);
const folderEntries = tweetEntries(FOLDER, ['data', 'bookmark_collection_timeline']);
const idOf = (e) => {
  const r = e.content.itemContent.tweet_results.result;
  return r.rest_id ?? r.tweet?.rest_id;
};
const tweetsOf = (entries) => Object.fromEntries(entries.map((e) => [idOf(e), e.content.itemContent.tweet_results.result]));

let dir;
let delays;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'timeline-'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-19T03:00:00.000Z'));
  delays = [];
  (await scraper()).__delayHooks.onDelay = (label) => delays.push(label);
});
afterEach(async () => {
  (await scraper()).__delayHooks.onDelay = null;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const op = (u) => u.pathname.split('/').pop();
const queryIdOf = (u) => u.pathname.split('/').at(-2);
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Likes timeline of the five bookmark-fixture tweets: 3 on page 1, 2 on page 2. */
function likesScenario() {
  return mockPage({
    pages: (cursor) => (cursor === null
      ? { json: likesPage(bookmarkEntries.slice(0, 3), 'c1') }
      : { json: likesPage(bookmarkEntries.slice(3), 'c2') }),
    tweets: tweetsOf(bookmarkEntries),
  });
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

describe('resolveTimelineOperation', () => {
  it('resolves the four keys from the generated table when discovery has failed', async () => {
    const qi = await import('../src/scrapers/twitter/http/queryIds.js');
    const ep = await import('../src/scrapers/twitter/http/endpoints.js');
    qi.configureQueryIds({ cacheDir: dir, fetch: async () => { throw new Error('offline'); } });
    try {
      await expect(qi.refreshQueryIds({ cacheDir: dir })).rejects.toThrow();
      const { resolveTimelineOperation } = await scraper();
      const likes = resolveTimelineOperation('UserLikes');
      expect(likes[0]).toMatchObject({ operationName: 'Likes', source: 'hardcoded', queryId: ep.UPSTREAM_OPERATIONS.Likes.queryId });
      expect(likes[0].queryId).not.toBe(ep.UPSTREAM_OPERATIONS.Favoriters.queryId);
      expect(likes[0].features).toEqual(ep.operationFeatures('Likes'));
      expect(likes.at(-1)).toMatchObject({ queryId: 'KPuet6dGbC8LB2sOLx7tZQ', source: 'legacy' });
      expect(resolveTimelineOperation('BookmarkTimeline')[0]).toMatchObject({ operationName: 'Bookmarks', queryId: 'iblrFnKr6PZUR-dWpfXG6g' });
      expect(resolveTimelineOperation('BookmarkFolderTimeline')[0]).toMatchObject({ operationName: 'BookmarkFolderTimeline', queryId: 'U16iHLDthyj_mXaEbCuaaQ' });
      const slice = resolveTimelineOperation('BookmarkFoldersSlice')[0];
      expect(slice).toMatchObject({ operationName: 'BookmarkFoldersSlice', queryId: 'i78YDd0Tza-dV4SYs58kRg' });
      expect(slice.fieldToggles).toBeUndefined();
    } finally {
      qi.configureQueryIds({});
    }
  });

  it('prefers a discovered queryId from the cache', async () => {
    const qi = await import('../src/scrapers/twitter/http/queryIds.js');
    writeFileSync(join(dir, 'query-ids.json'), JSON.stringify({
      fetchedAt: new Date().toISOString(),
      operations: {
        Bookmarks: { queryId: 'CACHEDbookmarks', operationType: 'query' },
        Likes: { queryId: 'CACHEDlikes', operationType: 'query' },
        Favoriters: { queryId: 'CACHEDfavoriters', operationType: 'query' },
      },
    }));
    qi.configureQueryIds({ cacheDir: dir });
    try {
      const { resolveTimelineOperation } = await scraper();
      expect(resolveTimelineOperation('BookmarkTimeline')[0]).toMatchObject({ queryId: 'CACHEDbookmarks', source: 'cache' });
      // The user's likes, never the cached Favoriters id (upstream's own
      // resolveGraphQL('UserLikes') returns that one).
      expect(resolveTimelineOperation('UserLikes')[0]).toMatchObject({ queryId: 'CACHEDlikes', operationName: 'Likes', source: 'cache' });
      // A stale cached id falls back to the pinned one, then the legacy one.
      expect(resolveTimelineOperation('UserLikes').map((c) => c.source)).toEqual(['cache', 'hardcoded', 'legacy']);
    } finally {
      qi.configureQueryIds({});
    }
  });

  it('refuses the key Likes, which upstream maps to Favoriters', async () => {
    const { resolveTimelineOperation } = await scraper();
    expect(() => resolveTimelineOperation('Likes')).toThrow(/Favoriters/);
  });

  it('no timeline code names the upstream key Likes', () => {
    const src = readFileSync(join(here, '../src/scrapers/twitter/index.js'), 'utf8');
    expect(src).not.toMatch(/resolveGraphQL\(\s*['"]Likes['"]/);
    expect(src).not.toMatch(/GRAPHQL\.Likes\b/);
    expect(src).not.toMatch(/resolveTimelineOperation\(\s*['"]Likes['"]/);
    expect(src).toMatch(/operation: 'UserLikes'/);
  });
});

// ---------------------------------------------------------------------------
// Likes through the loop
// ---------------------------------------------------------------------------

describe('discoverLikes', () => {
  it('builds the request from the resolver and reports the new fields', async () => {
    const { discoverLikes } = await scraper();
    const { page, log } = likesScenario();
    const r = await drain(discoverLikes(page, 'u', { limit: 5, exportDir: dir }));
    const u = new URL(log.timeline[0].url);
    expect(op(u)).toBe('Likes');
    expect(queryIdOf(u)).not.toBe('KPuet6dGbC8LB2sOLx7tZQ');
    expect(JSON.parse(u.searchParams.get('features'))).toEqual((await import('../src/scrapers/twitter/http/endpoints.js')).operationFeatures('Likes'));
    expect(r).toMatchObject({ kind: 'like', scope: null, likesCount: 5, deepReadsCount: 5, skippedDeep: 0, deferredDeep: 0, listingComplete: true });
    expect(r.likesFile.startsWith(dir)).toBe(true);
  });

  it('lists every page before the first deep read', async () => {
    const { discoverLikes } = await scraper();
    const order = [];
    const { page } = likesScenario();
    const evaluate = page.evaluate;
    page.evaluate = async (fn, ...args) => {
      const a = args[0];
      if (typeof a === 'string' && args.length === 1) order.push('read');
      else if (a?.url) order.push('list');
      return evaluate(fn, ...args);
    };
    await drain(discoverLikes(page, 'u', { limit: 5, exportDir: dir }));
    expect(order.slice(0, 2)).toEqual(['list', 'list']);
    expect(order.slice(2).every((s) => s === 'read')).toBe(true);
  });

  it('falls back to the legacy likes queryId when the resolved one is refused', async () => {
    const { discoverLikes } = await scraper();
    const { page, log } = mockPage({
      pages: (cursor, u) => (queryIdOf(u) === 'KPuet6dGbC8LB2sOLx7tZQ'
        ? { json: likesPage(bookmarkEntries.slice(0, 2), null) }
        : { status: 404, json: '{"errors":[{"message":"Query not found"}]}' }),
      tweets: tweetsOf(bookmarkEntries),
    });
    const r = await drain(discoverLikes(page, 'u', { limit: 5, exportDir: dir }));
    expect(log.timeline.map((t) => queryIdOf(new URL(t.url)))).toEqual([expect.not.stringMatching(/^KPuet6/), 'KPuet6dGbC8LB2sOLx7tZQ']);
    expect(r).toMatchObject({ likesCount: 2, queryId: 'KPuet6dGbC8LB2sOLx7tZQ', queryIdSource: 'legacy', listingComplete: true });
  });

  it('skipIds: listed in the shallow file, no deep read and no pause before it', async () => {
    const { discoverLikes } = await scraper();
    const ids = bookmarkEntries.map(idOf);
    const skipFile = join(dir, 'known');
    writeFileSync(skipFile, `${ids[0]}\n${ids[2]}\n`);
    const { page, log } = likesScenario();
    const r = await drain(discoverLikes(page, 'u', { limit: 5, exportDir: dir, skipIds: skipFile }));
    expect(lines(r.likesFile).map((t) => t.id)).toEqual(ids);
    expect(r.skippedDeep).toBe(2);
    expect(r.deepReadsCount).toBe(3);
    expect(log.detail).not.toContain(ids[0]);
    expect(log.detail).not.toContain(ids[2]);
    expect(delays.filter((d) => d === 'pre-read')).toHaveLength(3);
    expect(lines(r.deepReadsFile).map((d) => d.thread[0].id)).toEqual([ids[1], ids[3], ids[4]]);
  });

  it('skipIds holding every listed id: no deep file, no deep read', async () => {
    const { discoverLikes } = await scraper();
    const skipFile = join(dir, 'known');
    writeFileSync(skipFile, bookmarkEntries.map(idOf).join(','));
    const { page, log } = likesScenario();
    const r = await drain(discoverLikes(page, 'u', { limit: 5, exportDir: dir, skipIds: skipFile }));
    expect(r).toMatchObject({ likesCount: 5, deepReadsCount: 0, skippedDeep: 5 });
    expect(log.detail).toEqual([]);
    expect(delays).not.toContain('pre-read');
    expect(existsSync(r.deepReadsFile)).toBe(false);
  });

  it('maxDeep caps the deep reads, newest first; skipped posts do not count against it', async () => {
    const { discoverLikes } = await scraper();
    const ids = bookmarkEntries.map(idOf);
    const skipFile = join(dir, 'known');
    writeFileSync(skipFile, ids[0]);
    const { page } = likesScenario();
    const r = await drain(discoverLikes(page, 'u', { limit: 5, exportDir: dir, skipIds: skipFile, maxDeep: 2 }));
    expect(r).toMatchObject({ likesCount: 5, deepReadsCount: 2, skippedDeep: 1, deferredDeep: 2 });
    expect(lines(r.deepReadsFile).map((d) => d.thread[0].id)).toEqual([ids[1], ids[2]]);
  });

  it('listingComplete is false when listing stops on transport failures', async () => {
    const { discoverLikes } = await scraper();
    const { page } = likesScenario();
    const evaluate = page.evaluate;
    let listCalls = 0;
    page.evaluate = async (fn, ...args) => {
      if (args[0]?.url && ++listCalls > 1) return { error: 'fetch_failed' };
      return evaluate(fn, ...args);
    };
    const r = await drain(discoverLikes(page, 'u', { limit: 5, exportDir: dir }));
    expect(r).toMatchObject({ likesCount: 3, listingComplete: false, deepReadsCount: 3 });
  });

  it('listingComplete is true when the timeline ends before the limit', async () => {
    const { discoverLikes } = await scraper();
    const { page } = mockPage({ pages: () => ({ json: likesPage(bookmarkEntries.slice(0, 2), null) }), tweets: tweetsOf(bookmarkEntries) });
    const r = await drain(discoverLikes(page, 'u', { limit: 50, exportDir: dir }));
    expect(r).toMatchObject({ likesCount: 2, listingComplete: true });
  });

  it('defaults exportDir to $XACTIONS_HOME/exports', async () => {
    const { discoverLikes } = await scraper();
    const saved = process.env.XACTIONS_HOME;
    process.env.XACTIONS_HOME = join(dir, 'home');
    try {
      const { page } = likesScenario();
      const r = await drain(discoverLikes(page, 'u', { limit: 5 }));
      expect(r.likesFile).toBe(join(dir, 'home', 'exports', 'likes-u-2026-10-19T03-00-00-000Z.jsonl'));
    } finally {
      if (saved === undefined) delete process.env.XACTIONS_HOME; else process.env.XACTIONS_HOME = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Bookmarks and folders
// ---------------------------------------------------------------------------

function sliceOrTimeline(timeline, { sliceJson = SLICE } = {}) {
  return (cursor, u) => (op(u) === 'BookmarkFoldersSlice' ? { json: sliceJson } : timeline(cursor, u));
}

describe('discoverBookmarks', () => {
  it('all bookmarks: Bookmarks operation, probe variables, parsed rows, named files', async () => {
    const { discoverBookmarks } = await scraper();
    const ep = await import('../src/scrapers/twitter/http/endpoints.js');
    const end = { data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [] }] } } } };
    const { page, log } = mockPage({ pages: (cursor) => ({ json: cursor === null ? BOOKMARKS : end }), tweets: tweetsOf(bookmarkEntries) });
    const r = await drain(discoverBookmarks(page, 'u', { scope: 'all', limit: 50, exportDir: dir }));
    const u = new URL(log.timeline[0].url);
    expect(op(u)).toBe('Bookmarks');
    expect(queryIdOf(u)).toBe('iblrFnKr6PZUR-dWpfXG6g');
    expect(log.timeline[0].variables).toEqual({ count: 20, includePromotedContent: false });
    expect(JSON.parse(u.searchParams.get('features'))).toEqual(ep.operationFeatures('Bookmarks'));
    expect(JSON.parse(u.searchParams.get('fieldToggles'))).toEqual(ep.operationFieldToggles('Bookmarks'));
    expect(log.timeline[1].variables.cursor).toBe('HBailebB3pG2kjQAAA==');
    expect(r).toMatchObject({ kind: 'bookmark', scope: 'all', bookmarksCount: 5, listingComplete: true });
    expect(r.bookmarksFile).toBe(join(dir, 'bookmarks-u-all-2026-10-19T03-00-00-000Z.jsonl'));
    expect(r.deepReadsFile).toBe(join(dir, 'bookmarks-u-all-2026-10-19T03-00-00-000Z-deep.jsonl'));
    const rows = lines(r.bookmarksFile);
    expect(rows.map((t) => t.id)).toEqual(bookmarkEntries.map(idOf));
    expect(rows[0]).toMatchObject({ id: '2111962772594659640', author: 'stargocn', platform: 'twitter' });
    expect(rows[0].media[0]).toMatchObject({ type: 'photo' });
    expect(rows[0]).not.toHaveProperty('quotedTweetId');
  });

  it('one folder: BookmarkFolderTimeline with the folder id; X ignores count, limit caps at 5', async () => {
    const { discoverBookmarks } = await scraper();
    const { page, log } = mockPage({ pages: () => ({ json: FOLDER }), tweets: tweetsOf(folderEntries) });
    expect(folderEntries).toHaveLength(20);
    const r = await drain(discoverBookmarks(page, 'u', { scope: FOLDER_ID, limit: 5, exportDir: dir }));
    expect(log.timeline).toHaveLength(1);
    const u = new URL(log.timeline[0].url);
    expect(op(u)).toBe('BookmarkFolderTimeline');
    expect(queryIdOf(u)).toBe('U16iHLDthyj_mXaEbCuaaQ');
    expect(log.timeline[0].variables).toEqual({ bookmark_collection_id: FOLDER_ID, count: 20, includePromotedContent: false });
    expect(r).toMatchObject({ scope: FOLDER_ID, bookmarksCount: 5, deepReadsCount: 5, listingComplete: true });
    expect(r.bookmarksFile).toBe(join(dir, `bookmarks-u-${FOLDER_ID}-2026-10-19T03-00-00-000Z.jsonl`));
    expect(lines(r.bookmarksFile).map((t) => t.id)).toEqual(folderEntries.slice(0, 5).map(idOf));
  });

  it('one folder: finds the instructions under another container name', async () => {
    const { discoverBookmarks } = await scraper();
    const moved = { data: { renamed_collection_timeline: FOLDER.data.bookmark_collection_timeline } };
    const { page } = mockPage({ pages: () => ({ json: moved }), tweets: tweetsOf(folderEntries) });
    const r = await drain(discoverBookmarks(page, 'u', { scope: FOLDER_ID, limit: 3, exportDir: dir }));
    expect(r.bookmarksCount).toBe(3);
  });

  it('writes the shallow file when listing ends even when empty; the deep file stays lazy', async () => {
    const { discoverBookmarks } = await scraper();
    const empty = { data: { bookmark_collection_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [] }] } } } };
    const { page } = mockPage({ pages: sliceOrTimeline(() => ({ json: empty })) });
    const r = await drain(discoverBookmarks(page, 'u', { scope: FOLDER_ID, exportDir: dir }));
    expect(r).toMatchObject({ bookmarksCount: 0, listingComplete: true });
    expect(readFileSync(r.bookmarksFile, 'utf8')).toBe('');
    expect(existsSync(r.deepReadsFile)).toBe(false);
  });

  it('an HTTP error throws with the status and the first 300 characters of the body', async () => {
    const { discoverBookmarks } = await scraper();
    const body = `${'x'.repeat(300)}TAIL`;
    const { page } = mockPage({ pages: () => ({ status: 500, json: body }) });
    const err = await drain(discoverBookmarks(page, 'u', { exportDir: dir })).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(500);
    expect(err.message).toContain('500');
    expect(err.message).toContain('x'.repeat(300));
    expect(err.message).not.toContain('TAIL');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a 200 with no instructions throws', async () => {
    const { discoverBookmarks } = await scraper();
    const { page } = mockPage({ pages: () => ({ json: { data: {} } }) });
    await expect(drain(discoverBookmarks(page, 'u', { exportDir: dir }))).rejects.toThrow(/Bookmarks: X answered 200/);
  });

  it('a folder X answers with an error, absent from the folder list, is FOLDER_NOT_FOUND', async () => {
    const { discoverBookmarks } = await scraper();
    const { page } = mockPage({
      pages: sliceOrTimeline(() => ({ json: { errors: [{ message: 'Not found', code: 34 }] } })),
    });
    const err = await drain(discoverBookmarks(page, 'u', { scope: '1234567890', exportDir: dir })).catch((e) => e);
    expect(err.code).toBe('FOLDER_NOT_FOUND');
    expect(err.message).toMatch(/^FOLDER_NOT_FOUND/);
    expect(err.message).toContain('Not found');
    expect(err.folderId).toBe('1234567890');
  });

  it('a folder X answers with an empty timeline, absent from the folder list, is FOLDER_NOT_FOUND', async () => {
    const { discoverBookmarks } = await scraper();
    const empty = { data: { bookmark_collection_timeline: { timeline: { instructions: [] } } } };
    const { page } = mockPage({ pages: sliceOrTimeline(() => ({ json: empty })) });
    const err = await drain(discoverBookmarks(page, 'u', { scope: '1234567890', exportDir: dir })).catch((e) => e);
    expect(err.code).toBe('FOLDER_NOT_FOUND');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('an error on a folder that does exist keeps X\'s error and no folder code', async () => {
    const { discoverBookmarks } = await scraper();
    const { page } = mockPage({ pages: sliceOrTimeline(() => ({ status: 503, json: 'busy' })) });
    const err = await drain(discoverBookmarks(page, 'u', { scope: FOLDER_ID, exportDir: dir })).catch((e) => e);
    expect(err.code).toBeUndefined();
    expect(err.status).toBe(503);
  });

  it('refuses a scope that is neither all nor a numeric folder id', async () => {
    const { discoverBookmarks } = await scraper();
    const { page } = mockPage({ pages: () => ({ json: BOOKMARKS }) });
    await expect(discoverBookmarks(page, 'u', { scope: '../x' })).rejects.toThrow(/Invalid bookmark scope/);
  });
});

describe('listBookmarkFolders', () => {
  it('returns the probe account\'s ten folders as {id, name}, names untrimmed', async () => {
    const { listBookmarkFolders } = await scraper();
    const { page, log } = mockPage({ pages: () => ({ json: SLICE }) });
    const folders = await drain(listBookmarkFolders(page));
    expect(folders).toHaveLength(10);
    expect(folders[0]).toEqual({ id: '2023272167308476678', name: 'Prompts ' });
    expect(folders.at(-1)).toEqual({ id: '1734049140290859424', name: 'airdrops' });
    const u = new URL(log.timeline[0].url);
    expect(op(u)).toBe('BookmarkFoldersSlice');
    expect(log.timeline[0].variables).toEqual({});
    expect(u.searchParams.has('fieldToggles')).toBe(false);
  });

  it('pages through slice_info.next_cursor', async () => {
    const { listBookmarkFolders } = await scraper();
    const items = SLICE.data.viewer.user_results.result.bookmark_collections_slice.items;
    const slice = (part, next) => ({ data: { viewer: { user_results: { result: { bookmark_collections_slice: { items: part, slice_info: next ? { next_cursor: next } : {} } } } } } });
    const { page, log } = mockPage({ pages: (cursor) => ({ json: cursor === null ? slice(items.slice(0, 4), 'n1') : slice(items.slice(4), null) }) });
    const folders = await drain(listBookmarkFolders(page));
    expect(folders.map((f) => f.id)).toEqual(items.map((i) => i.id));
    expect(log.timeline[1].variables).toEqual({ cursor: 'n1' });
  });

  it('a response with no slice throws', async () => {
    const { listBookmarkFolders } = await scraper();
    const { page } = mockPage({ pages: () => ({ status: 403, json: '{"errors":[{"message":"Forbidden"}]}' }) });
    await expect(drain(listBookmarkFolders(page))).rejects.toThrow(/BookmarkFoldersSlice: X answered 403/);
  });
});

