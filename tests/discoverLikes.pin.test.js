// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Pin: `discoverLikes` called with none of the timeline options writes what it
 * wrote before the timeline loop was extracted — the same two file names,
 * created lazily, with the same lines.
 *
 * The golden file was produced by running this test against the pre-refactor
 * build (likewiki/main 67b4612) with PIN_WRITE_GOLDEN=1. Fake timers fix the
 * clock, so the timestamped file names are part of the pin.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, tweetEntries, likesPage, mockPage, drain } from './discoverTimeline.helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(here, 'fixtures/x-timelines/likes-pin.golden.json');

let home;
const saved = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'likes-pin-'));
  for (const k of ['HOME', 'XACTIONS_HOME']) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.XACTIONS_HOME = join(home, '.xactions');
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-19T03:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

function scenario() {
  const entries = tweetEntries(fixture('BookmarkTimeline'), ['data', 'bookmark_timeline_v2']);
  const tweets = Object.fromEntries(entries.map((e) => {
    const r = e.content.itemContent.tweet_results.result;
    return [r.rest_id ?? r.tweet?.rest_id, r];
  }));
  // Page 1: three tweets; page 2: the other two. X ignores the requested count.
  const pages = (cursor) => (cursor === null
    ? { json: likesPage(entries.slice(0, 3), 'c1') }
    : { json: likesPage(entries.slice(3), 'c2') });
  return mockPage({ pages, tweets });
}

describe('discoverLikes output pin', () => {
  it('writes the same files, names and lines as before the timeline loop', async () => {
    const { discoverLikes } = await import('../src/scrapers/twitter/index.js');
    const { page } = scenario();
    const result = await drain(discoverLikes(page, 'pinuser', { limit: 5 }));

    const dir = join(home, '.xactions', 'exports');
    const files = readdirSync(dir).sort().map((name) => ({ name, content: readFileSync(join(dir, name), 'utf8') }));
    const legacy = {
      likesFile: result.likesFile.replace(home, '<HOME>'),
      deepReadsFile: result.deepReadsFile.replace(home, '<HOME>'),
      likesCount: result.likesCount,
      deepReadsCount: result.deepReadsCount,
      username: result.username,
      dateRange: result.dateRange,
    };
    const actual = { files, result: legacy };

    if (process.env.PIN_WRITE_GOLDEN) writeFileSync(GOLDEN, JSON.stringify(actual, null, 1));
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    expect(actual).toEqual(golden);
    expect(files.map((f) => f.name)).toEqual([
      'likes-pinuser-2026-10-19T03-00-00-000Z-deep.jsonl',
      'likes-pinuser-2026-10-19T03-00-00-000Z.jsonl',
    ]);
  });

  it('creates neither file when the timeline lists nothing', async () => {
    const { discoverLikes } = await import('../src/scrapers/twitter/index.js');
    const { page } = mockPage({ pages: () => ({ json: likesPage([], null) }) });
    await drain(discoverLikes(page, 'pinuser', { limit: 5 }));
    let names = [];
    try { names = readdirSync(join(home, '.xactions', 'exports')); } catch { /* dir absent is fine */ }
    expect(names).toEqual([]);
  });
});
