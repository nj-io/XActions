// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * MCP: x_discover_bookmarks and x_list_bookmark_folders are declared, grouped
 * as read tools and implemented, x_discover_likes takes the timeline options,
 * and a folder the account does not have comes back as an MCP error payload
 * carrying FOLDER_NOT_FOUND.
 *
 * The scrapers and the browser are mocked; the scraper behaviour itself is
 * covered by tests/discoverTimeline.test.js.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const calls = vi.hoisted(() => ({ likes: [], bookmarks: [] }));
const pluginTools = vi.hoisted(() => []);

vi.mock('../../src/scrapers/index.js', async (importOriginal) => {
  const real = await importOriginal();
  const fakePage = () => ({ setDefaultTimeout() {}, close: async () => {}, setCookie: async () => {}, isClosed: () => false });
  return {
    ...real,
    createBrowser: async () => ({ isConnected: () => true, close: async () => {}, newPage: async () => fakePage() }),
    createPage: async () => fakePage(),
    discoverLikes: async (_page, username, options) => {
      calls.likes.push({ username, options });
      return { likesCount: 0 };
    },
    discoverBookmarks: async (_page, username, options) => {
      calls.bookmarks.push({ username, options });
      if (options.scope === '999') {
        throw Object.assign(new Error('FOLDER_NOT_FOUND: bookmark folder 999 is not among this account\'s folders'), {
          code: 'FOLDER_NOT_FOUND', folderId: '999',
        });
      }
      return { bookmarksCount: 0, scope: options.scope };
    },
    listBookmarkFolders: async () => [{ id: '2023272167308476678', name: 'Prompts ' }],
  };
});

// The server keeps its local tool table private until main() starts the
// local backend, so the wire test reaches the real local tool through a
// plugin tool of the same name; the error path it exercises is the same
// catch every tool call goes through.
vi.mock('../../src/plugins/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getPluginTools: () => pluginTools,
}));

let TOOLS;
let createMcpServer;
let local;
let groups;

beforeAll(async () => {
  ({ TOOLS, createMcpServer } = await import('../../src/mcp/server.js'));
  local = await import('../../src/mcp/local-tools.js');
  groups = await import('../../src/mcp/tool-groups.js');
});

describe('bookmark tools', () => {
  it('are declared, implemented and in the read group', () => {
    for (const name of ['x_discover_bookmarks', 'x_list_bookmark_folders']) {
      expect(TOOLS.some((t) => t.name === name), name).toBe(true);
      expect(typeof local.toolMap[name], name).toBe('function');
      expect(groups.groupOf(name), name).toBe('read');
      expect(groups.WRITE_TOOLS.has(name), name).toBe(false);
    }
    const schema = TOOLS.find((t) => t.name === 'x_discover_bookmarks').inputSchema.properties;
    expect(Object.keys(schema)).toEqual(['username', 'scope', 'limit', 'skipIds', 'maxDeep', 'exportDir']);
    const likes = TOOLS.find((t) => t.name === 'x_discover_likes').inputSchema.properties;
    expect(likes).toHaveProperty('skipIds');
    expect(likes).toHaveProperty('maxDeep');
    expect(likes).toHaveProperty('exportDir');
  });

  it('x_discover_likes passes skipIds, maxDeep and exportDir through', async () => {
    await local.x_discover_likes({ username: 'u', limit: 20, skipIds: '/tmp/k', maxDeep: 3, exportDir: '/tmp/e' });
    expect(calls.likes.at(-1)).toEqual({ username: 'u', options: { limit: 20, from: undefined, to: undefined, skipIds: '/tmp/k', maxDeep: 3, exportDir: '/tmp/e' } });
  });

  it('x_discover_bookmarks defaults scope to all and passes the options through', async () => {
    await local.x_discover_bookmarks({ username: 'u', maxDeep: 40 });
    expect(calls.bookmarks.at(-1)).toEqual({ username: 'u', options: { scope: 'all', limit: 50, skipIds: undefined, maxDeep: 40, exportDir: undefined } });
  });

  it('x_list_bookmark_folders returns {folders}', async () => {
    expect(await local.x_list_bookmark_folders()).toEqual({ folders: [{ id: '2023272167308476678', name: 'Prompts ' }] });
  });

  it('a missing folder is an MCP error payload carrying FOLDER_NOT_FOUND', async () => {
    pluginTools.splice(0, pluginTools.length, {
      name: 'x_discover_bookmarks',
      description: 'test route to the local tool',
      inputSchema: { type: 'object', properties: {} },
      handler: (args) => local.x_discover_bookmarks(args),
    });
    const server = createMcpServer({ tools: '', exclude: '' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'bookmark-test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const res = await client.callTool({ name: 'x_discover_bookmarks', arguments: { username: 'u', scope: '999' } });
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text);
      expect(body.code).toBe('FOLDER_NOT_FOUND');
      expect(body.error).toMatch(/^FOLDER_NOT_FOUND/);
    } finally {
      pluginTools.splice(0, pluginTools.length);
      await client.close();
      await server.close();
    }
  });
});
