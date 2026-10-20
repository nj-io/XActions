# LikeWiki's xactions

This fork (`nj-io/xactions`, branch `likewiki/main`) is the xactions build that LikeWiki's nightly capture runs. It is upstream `nirholas/XActions` 3.5.0 plus the changes below. The fork is public; it holds no secrets, and the session cookie reaches the server only through the environment of the process that starts it.

LikeWiki starts the server itself, with no model in between: `scripts/xactions_call.py` in the LikeWiki repo reads `mcpServers.xactions` from `~/.claude.json` (command, args, env) and speaks the MCP stdio protocol to it. On the Mac Mini `args` points at `~/xactions-current/src/mcp/server.js`, a symlink to the installed checkout.

## What the changes are

All of them are additions to upstream files or new files; no upstream behaviour is altered for a caller that passes none of the new options.

| Change | Where |
|---|---|
| Tools `x_discover_likes`, `x_discover_bookmarks`, `x_list_bookmark_folders`, `x_read_post`, `x_read_article` | `src/mcp/local-tools.js`, registered in `src/mcp/server.js` and listed in the local group of `src/mcp/tool-groups.js` |
| One timeline loop, `discoverTimeline`, that lists a timeline first and deep-reads afterwards. `discoverLikes`, `discoverBookmarks` and `listBookmarkFolders` are built on it | `src/scrapers/twitter/index.js`, exported from `src/scrapers/index.js` |
| Deep read of one post: thread, quoted post and its thread, media, article stub | `scrapePost` and the recursive post reader in `src/scrapers/twitter/index.js` |
| Article capture as markdown (headings, lists, code fences, bold, inline images) from the read view's DOM, and `x_read_article` with an absolute `saveTo` | `src/mcp/articleMarkdown.js`, `src/mcp/articleText.js`, `x_read_article` |
| Batch article re-fetch, resumable | `bin/refetch-articles.mjs` |
| Tests and fixtures: a golden pin of `discoverLikes` output, X timeline fixtures for likes, bookmarks and folders, the timeline loop's tests, article tests | `tests/discoverLikes.pin.test.js`, `tests/discoverTimeline*.js`, `tests/mcp/bookmark-tools.test.js`, `tests/articleMarkdown.test.js`, `tests/fixtures/x-timelines/` |

### Timelines

The loop takes `{kind, scope, username, limit, operation, variables(cursor), instructionsOf(data), exportDir, skipIds, maxDeep}`.

- **Operations.** Likes use the upstream key `UserLikes`, bookmarks `BookmarkTimeline`, a folder's bookmarks `BookmarkFolderTimeline`, and the folder list `BookmarkFoldersSlice`. The key `Likes` is never used: upstream maps it to `Favoriters`, the users who liked one post, so it would fetch the wrong timeline. `resolveTimelineOperation(key)` returns the request shapes to try, best first: the query id in the discovery cache (`~/.xactions/query-ids.json`), then the generated table's, and for likes the legacy query id `KPuet6dGbC8LB2sOLx7tZQ` with its feature set. A failed discovery is not fatal; the pinned table answers.
- **Requests** are built in Node and fetched inside the logged-in page with `page.evaluate`, so the cookie, bearer token and csrf token are the browser session's. An HTTP error, or a 200 with none of the operation's data, throws `TimelineRequestError` carrying X's status and the first 300 characters of the body.
- **List first, then read.** Every page of the timeline is listed, up to `limit`, before any deep read. The result carries `listingComplete`: the limit was reached or the timeline ended. A run cut short during deep reads still leaves a complete listing whenever listing finished.
- **Options every timeline tool takes.** `skipIds` is a path to a file of tweet ids; a listed tweet in it enters the shallow index and is neither deep-read nor delayed. `maxDeep` is the most deep reads one call makes, newest first. `exportDir` defaults to `$XACTIONS_HOME/exports` (`~/.xactions/exports`).
- **Files.** Likes write `likes-<user>-<ts>.jsonl` and `likes-<user>-<ts>-deep.jsonl`, each created with its first batch. Bookmarks write `bookmarks-<user>-<scope>-<ts>.jsonl` and `-deep.jsonl`, where `<scope>` is `all` or the folder id; the shallow file is written when listing ends, even when empty.
- **Result.** `kind`, `scope`, the file paths and counts, `skippedDeep`, `deferredDeep`, `listingComplete`, and the query id and where it came from.
- **A folder the account lacks.** `x_discover_bookmarks` rejects with `code: 'FOLDER_NOT_FOUND'`, which the server returns as an error payload; LikeWiki exits 6 on it and skips the stream.
- **Folder names** can carry trailing spaces (`"Prompts "`). Ids are the identity.

## The regression gate

A change to the capture path, or a new upstream release, must give the same output as the build it replaces before it is deployed. The gate runs the installed build (old) and the candidate (new) through the same calls, side by side, and compares what they return. It is a harness on the machine that runs the server, not part of this repository, because it needs the live session.

1. One config file per build, in the shape of `~/.claude.json` (`mcpServers.xactions` with that build's `args` and the same cookie). The harness starts each build through LikeWiki's `xactions_call.Server`, with `XACTIONS_CLAUDE_JSON` naming that build's file.
2. A scratch `HOME` and `XACTIONS_HOME` per build, and every `saveTo` inside the scratch directory, so neither build touches the corpus or the other's exports. The pre-3.5 build hard-codes `$HOME/.xactions/exports`.
3. Run under `runlock.py hold --lock raw/xactions.lock --owner xactions-gate`, outside 19:30 to 23:30 UTC, one build at a time (they share the account's browser session).
4. The same calls to each build: `x_login`; `x_discover_likes` with `limit` 20; `x_read_article` on three articles taken from earlier article worklists; `x_read_post` on three posts. Then, for the bookmark tools, `x_list_bookmark_folders` and `x_discover_bookmarks` for `all` and for one folder, 5 entries each, and a made-up folder id, which must fail with X's error rather than return an empty success.
5. Compare: the same tweet ids in the same order; the same deep-read fields (`thread[]`, `media[]`, `article`, `quotedPost`) on each entry; matching article markdown. With `skipIds` holding all 20 ids, `x_discover_likes` lists the same 20 and deep-reads none. Every difference is listed and explained before the build is deployed.

## Deploying and rolling back

On the Mac Mini the candidate is cloned to `~/xactions-next` and installed with `npm ci --omit=dev`. Deploying is one command, and so is the rollback; `~/.claude.json` is not edited per switch (Claude Code rewrites that file, so its `args` was changed once, to go through the symlink).

```sh
ln -sfn ~/xactions-next ~/xactions-current    # deploy
ln -sfn ~/xactions ~/xactions-current         # roll back to the previous tree
```

`~/xactions` is the previous tree, upstream's March code plus the earlier form of these changes. It stays untouched until the new build has run clean for two nights. A server already running keeps its old code until it restarts; the nightly capture starts a new one each run.

## Taking an upstream release

1. `git fetch origin` (upstream `nirholas/XActions`) and `git checkout likewiki/main`.
2. `git merge origin/main`. Conflicts fall in the files this fork edits: `src/mcp/server.js`, `src/mcp/local-tools.js`, `src/mcp/tool-groups.js`, `src/scrapers/index.js` and `src/scrapers/twitter/index.js`. Keep upstream's code and re-apply the additions in the table above on top of it. Where upstream now covers something the fork patched (query-id discovery, request signing), use upstream's.
3. `npm ci --omit=dev`, then `npx vitest run tests/discoverLikes.pin.test.js tests/discoverTimeline.test.js tests/mcp/bookmark-tools.test.js tests/articleMarkdown.test.js tests/articleText.test.js`. The pin test fails if `discoverLikes` output changes for a caller that passes no new option.
4. Run the regression gate above against the installed build.
5. Push `likewiki/main` to `fork`, clone it to `~/xactions-next` on the Mini, install, run the gate there once more on the installed tree, and switch the symlink.

The fork's changes are not offered back to upstream; that is a separate decision.
