// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * XActions Twitter Scrapers
 * Puppeteer-based scrapers for X/Twitter
 * 
 * Moved from src/scrapers/index.js to support multi-platform architecture.
 * All original exports are preserved for backward compatibility.
 * 
 * Supports multiple frameworks via the adapter option:
 *   createBrowser({ adapter: 'playwright' })  // Use Playwright
 *   createBrowser({ adapter: 'puppeteer' })   // Use Puppeteer (default)
 *   createBrowser()                            // Legacy Puppeteer (no adapter wrapping)
 * 
 * @author nich (@nichxbt) - https://github.com/nirholas
 * @see https://xactions.app
 * @license Apache-2.0
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs/promises';
import path from 'path';
import {
  BEARER_TOKEN,
  buildGraphQLUrl,
  operationFeatures,
  operationFieldToggles,
  resolveGraphQL,
  UPSTREAM_OPERATIONS,
} from './http/endpoints.js';
import { loadCache as loadQueryIdCache } from './http/queryIds.js';
import { sessionDir } from '../../utils/savedSession.js';

puppeteer.use(StealthPlugin());

// UserByScreenName resolution. X rotates the GraphQL queryId periodically; the
// first id that returns a rest_id wins, the later ones are fallbacks. Keep the
// current id first (mirror src/scrapers/twitter/http/endpoints.js when it moves).
const USER_BY_SCREEN_NAME_QUERY_IDS = [
  'NimuplG1OB7Fd2btCLdBOw', // current (matches the HTTP-path resolver)
  'IGgvgiOx4QZndDHuD3x9TQ', // legacy fallback
];

// Full feature set X requires for UserByScreenName. A missing required flag makes
// X reject the whole call ("features cannot be null: …"); extra flags are ignored.
// Mirrors DEFAULT_FEATURES in the HTTP-path endpoints so the two paths stay in sync.
const USER_BY_SCREEN_NAME_FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  rweb_tipjar_consumption_enabled: false,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

// ============================================================================
// Core Utilities
// ============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Test seam: when set, `onDelay(label, min, max)` is called for every
 * randomDelay, so a test can tell which pauses ran. Unset in production.
 */
export const __delayHooks = { onDelay: null };

/** Human-like delay using log-normal distribution with occasional distraction spikes. */
const randomDelay = (min = 2000, max = 7000, label = null) => {
  __delayHooks.onDelay?.(label, min, max);
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
  const median = min + (max - min) * 0.4;
  const spread = (max - min) * 0.25;
  const base = median + z * spread;
  const distraction = Math.random() < 0.08 ? 8000 + Math.random() * 12000 : 0;
  const delay = Math.max(min, Math.min(base, max)) + distraction;
  return sleep(delay);
};

/** Throw if the page redirected to login (expired/invalid cookie). */
function checkAuth(page) {
  const url = page.url();
  if (url.includes('/login') || url.includes('/i/flow/login')) {
    throw new Error('Authentication failed — cookie may be expired.\n\nRun: xactions login');
  }
}

/**
 * Navigate to a page and wait for the content the scrape needs.
 *
 * `networkidle2` never settles on x.com's profile pages: media and ads keep
 * the connection pool busy, so the wait burned Puppeteer's whole 30s timeout
 * and `xactions export` died before reading a single field. `domcontentloaded`
 * returns as soon as the shell is in place; the selector is what makes that
 * wait meaningful, and a miss falls through to the caller's retry loop instead
 * of throwing.
 *
 * @param {Object} page
 * @param {string} url
 * @param {string} [waitFor] CSS selector marking the content to scrape
 * @returns {Promise<void>}
 */
async function gotoAndRender(page, url, waitFor) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (waitFor) {
    try {
      await page.waitForSelector(waitFor, { timeout: 15000 });
    } catch {
      // Nothing appeared; the caller's retries decide whether that is fatal.
    }
    return;
  }
  await randomDelay();
}


/**
 * Create a browser instance with stealth settings.
 * 
 * Supports adapter mode:
 *   const browser = await createBrowser({ adapter: 'playwright' });
 *   const browser = await createBrowser({ adapter: 'puppeteer' });
 *   const browser = await createBrowser(); // Legacy Puppeteer
 * 
 * @param {Object} [options]
 * @param {string} [options.adapter] - Framework adapter: 'puppeteer', 'playwright', 'cheerio'
 * @param {boolean} [options.headless] - Run headless (default: true)
 * @returns {Promise<Object>} Browser instance
 */
export async function createBrowser(options = {}) {
  if (options.adapter) {
    const { getAdapter } = await import('../adapters/index.js');
    const adapter = await getAdapter(options.adapter);
    const { adapter: _, ...adapterOptions } = options;
    return adapter.launch(adapterOptions);
  }

  return puppeteer.launch({
    headless: options.headless !== false ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
    ],
    ...options,
  });
}

/**
 * Create a page with realistic settings.
 * Works with both native Puppeteer browsers and adapter browsers.
 * 
 * @param {Object} browser - Browser instance (native or adapter)
 * @param {Object} [options]
 * @returns {Promise<Object>} Page instance
 */
export async function createPage(browser, options = {}) {
  if (browser._adapter) {
    const { getAdapter } = await import('../adapters/index.js');
    const adapter = await getAdapter(browser._adapter);
    return adapter.newPage(browser, options);
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280 + Math.floor(Math.random() * 100), height: 800 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  return page;
}

/**
 * Login with session cookie.
 * Works with both native Puppeteer pages and adapter pages.
 */
export async function loginWithCookie(page, authToken) {
  if (page._adapter) {
    const { getAdapter } = await import('../adapters/index.js');
    const adapter = await getAdapter(page._adapter);
    await adapter.setCookie(page, {
      name: 'auth_token',
      value: authToken,
      domain: '.x.com',
      path: '/',
      httpOnly: true,
      secure: true,
    });
    await adapter.goto(page, 'https://x.com/home', { waitUntil: 'domcontentloaded' });
    return page;
  }

  await page.setCookie({
    name: 'auth_token',
    value: authToken,
    domain: '.x.com',
    path: '/',
    httpOnly: true,
    secure: true,
  });
  // Only the cookie has to land here — nothing is read off this page — so do
  // not ask for `networkidle2`: x.com's timeline sits just under the 30s
  // navigation timeout and blew past it on busy connections, failing every
  // command before it reached its own URL.
  await gotoAndRender(page, 'https://x.com/home');
  return page;
}

// ============================================================================
// Profile Scraper
// ============================================================================

/**
 * Scrape profile information for a user
 */
export async function scrapeProfile(page, username) {
  await gotoAndRender(page, `https://x.com/${username}`, '[data-testid="UserName"]');

  const profile = await page.evaluate(() => {
    const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
    const getAttr = (sel, attr) => document.querySelector(sel)?.getAttribute(attr) || null;

    const headerStyle = document.querySelector('[data-testid="UserProfileHeader_Items"]')
      ?.closest('div')?.previousElementSibling?.querySelector('img')?.src;

    const avatar = document.querySelector('[data-testid="UserAvatar-Container-unknown"] img, [data-testid*="UserAvatar"] img')?.src;

    const nameSection = document.querySelector('[data-testid="UserName"]');
    const fullText = nameSection?.textContent || '';
    const usernameMatch = fullText.match(/@(\w+)/);

    const followingLink = document.querySelector('a[href$="/following"]');
    const followersLink = document.querySelector('a[href$="/verified_followers"], a[href$="/followers"]');

    return {
      name: fullText.split('@')[0]?.trim() || null,
      username: usernameMatch?.[1] || null,
      bio: getText('[data-testid="UserDescription"]'),
      location: getText('[data-testid="UserLocation"]'),
      website: getAttr('[data-testid="UserUrl"]', 'href') || getAttr('[data-testid="UserUrl"] a', 'href'),
      joined: getText('[data-testid="UserJoinDate"]'),
      birthday: getText('[data-testid="UserBirthday"]'),
      following: followingLink?.querySelector('span')?.textContent || null,
      followers: followersLink?.querySelector('span')?.textContent || null,
      avatar: avatar || null,
      header: headerStyle || null,
      verified: !!document.querySelector('[data-testid="UserName"] svg[aria-label*="Verified"]'),
      protected: !!document.querySelector('[data-testid="UserName"] svg[aria-label*="Protected"]'),
      platform: 'twitter',
    };
  });

  return profile;
}

// ============================================================================
// Followers Scraper
// ============================================================================

/**
 * Scrape followers for a user
 */
export async function scrapeFollowers(page, username, options = {}) {
  const { limit = 1000, onProgress } = options;
  
  await gotoAndRender(page, `https://x.com/${username}/followers`, '[data-testid="UserCell"]');

  const followers = new Map();
  let retries = 0;
  const maxRetries = 10;

  while (followers.size < limit && retries < maxRetries) {
    const users = await page.evaluate(() => {
      const cells = document.querySelectorAll('[data-testid="UserCell"]');
      return Array.from(cells).map((cell) => {
        const link = cell.querySelector('a[href^="/"]');
        const nameEl = cell.querySelector('[dir="ltr"] > span');
        const bioEl = cell.querySelector('[data-testid="UserDescription"]');
        const verifiedEl = cell.querySelector('svg[aria-label*="Verified"]');
        const avatarEl = cell.querySelector('img[src*="profile_images"]');

        const href = link?.getAttribute('href') || '';
        const username = href.split('/')[1];

        return {
          username,
          name: nameEl?.textContent || null,
          bio: bioEl?.textContent || null,
          verified: !!verifiedEl,
          avatar: avatarEl?.src || null,
          platform: 'twitter',
        };
      }).filter(u => u.username && !u.username.includes('?'));
    });

    const prevSize = followers.size;
    users.forEach((u) => followers.set(u.username, u));

    if (onProgress) {
      onProgress({ scraped: followers.size, limit });
    }

    if (followers.size === prevSize) {
      retries++;
    } else {
      retries = 0;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomDelay(1500, 3000);
  }

  return Array.from(followers.values()).slice(0, limit);
}

// ============================================================================
// Following Scraper
// ============================================================================

/**
 * Scrape accounts a user is following
 */
export async function scrapeFollowing(page, username, options = {}) {
  const { limit = 1000, onProgress } = options;
  
  await gotoAndRender(page, `https://x.com/${username}/following`, '[data-testid="UserCell"]');

  const following = new Map();
  let retries = 0;
  const maxRetries = 10;

  while (following.size < limit && retries < maxRetries) {
    const users = await page.evaluate(() => {
      const cells = document.querySelectorAll('[data-testid="UserCell"]');
      return Array.from(cells).map((cell) => {
        const link = cell.querySelector('a[href^="/"]');
        const nameEl = cell.querySelector('[dir="ltr"] > span');
        const bioEl = cell.querySelector('[data-testid="UserDescription"]');
        const followsBackEl = cell.querySelector('[data-testid="userFollowIndicator"]');

        const href = link?.getAttribute('href') || '';
        const username = href.split('/')[1];

        return {
          username,
          name: nameEl?.textContent || null,
          bio: bioEl?.textContent || null,
          followsBack: !!followsBackEl,
          platform: 'twitter',
        };
      }).filter(u => u.username && !u.username.includes('?'));
    });

    const prevSize = following.size;
    users.forEach((u) => following.set(u.username, u));

    if (onProgress) {
      onProgress({ scraped: following.size, limit });
    }

    if (following.size === prevSize) {
      retries++;
    } else {
      retries = 0;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomDelay(1500, 3000);
  }

  return Array.from(following.values()).slice(0, limit);
}

// ============================================================================
// Tweet Scraper
// ============================================================================

/**
 * Scrape tweets from a user's profile
 */
export async function scrapeTweets(page, username, options = {}) {
  const { limit = 100, includeReplies = false, onProgress } = options;
  
  const url = includeReplies 
    ? `https://x.com/${username}/with_replies`
    : `https://x.com/${username}`;
    
  await gotoAndRender(page, url, 'article[data-testid="tweet"]');

  const tweets = new Map();
  let retries = 0;
  const maxRetries = 10;

  while (tweets.size < limit && retries < maxRetries) {
    const tweetData = await page.evaluate(() => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      return Array.from(articles).map((article) => {
        const textEl = article.querySelector('[data-testid="tweetText"]');
        const timeEl = article.querySelector('time');
        const linkEl = article.querySelector('a[href*="/status/"]');

        // Counts live in each action button's aria-label ("3944 Likes. Like"),
        // which carries the exact figure. The visible span read before is
        // abbreviated ("3.9K") and renders empty whenever the count is zero,
        // so every tweet came back with '0' — and as a string, which then
        // concatenated instead of summing in the callers. The fixture in
        // tests/searchSweep.test.js documents this same aria-label shape.
        const ariaCount = (selector) => {
          const label = article
            .querySelector(selector)
            ?.getAttribute('aria-label');
          const digits = label?.replace(/,/g, '').match(/\d+/);
          return digits ? Number(digits[0]) : 0;
        };

        
        const images = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img')).map(i => i.src);
        const video = article.querySelector('[data-testid="videoPlayer"]') ? true : false;
        
        const quotedEl = article.querySelector('[data-testid="quoteTweet"]');
        
        return {
          id: linkEl?.href?.match(/status\/(\d+)/)?.[1] || null,
          text: textEl?.textContent || null,
          timestamp: timeEl?.getAttribute('datetime') || null,
          likes: ariaCount('[data-testid="like"]'),
          retweets: ariaCount('[data-testid="retweet"]'),
          replies: ariaCount('[data-testid="reply"]'),
          views: ariaCount('a[href*="/analytics"]'),
          url: linkEl?.href || null,
          media: {
            images,
            hasVideo: video,
          },
          isQuote: !!quotedEl,
          isRetweet: !!article.querySelector('[data-testid="socialContext"]'),
          platform: 'twitter',
        };
      }).filter(t => t.id);
    });

    const prevSize = tweets.size;
    tweetData.forEach((t) => tweets.set(t.id, t));

    if (onProgress) {
      onProgress({ scraped: tweets.size, limit });
    }

    if (tweets.size === prevSize) {
      retries++;
    } else {
      retries = 0;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomDelay(1500, 3000);
  }

  return Array.from(tweets.values()).slice(0, limit);
}

// ============================================================================
// Search Scraper
// ============================================================================

/**
 * Search tweets by query
 */
export async function searchTweets(page, query, options = {}) {
  const { limit = 100, filter = 'latest', onProgress } = options;
  
  const filterMap = {
    latest: 'live',
    top: 'top',
    people: 'user',
    photos: 'image',
    videos: 'video',
  };
  
  const encodedQuery = encodeURIComponent(query);
  const f = filterMap[filter] || 'live';
  
  await gotoAndRender(
    page,
    `https://x.com/search?q=${encodedQuery}&src=typed_query&f=${f}`,
    'article[data-testid="tweet"]',
  );

  const tweets = new Map();
  let retries = 0;
  const maxRetries = 10;

  while (tweets.size < limit && retries < maxRetries) {
    const tweetData = await page.evaluate(() => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      return Array.from(articles).map((article) => {
        const textEl = article.querySelector('[data-testid="tweetText"]');
        const authorLink = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
        const timeEl = article.querySelector('time');
        const linkEl = article.querySelector('a[href*="/status/"]');

        // Counts live in each action button's aria-label ("3944 Likes. Like"),
        // which carries the exact figure. The visible span read before is
        // abbreviated ("3.9K") and renders empty whenever the count is zero,
        // so every tweet came back with '0' — and as a string, which then
        // concatenated instead of summing in the callers. The fixture in
        // tests/searchSweep.test.js documents this same aria-label shape.
        const ariaCount = (selector) => {
          const label = article
            .querySelector(selector)
            ?.getAttribute('aria-label');
          const digits = label?.replace(/,/g, '').match(/\d+/);
          return digits ? Number(digits[0]) : 0;
        };

        return {
          id: linkEl?.href?.match(/status\/(\d+)/)?.[1] || null,
          text: textEl?.textContent || null,
          author: authorLink?.href?.split('/')[3] || null,
          timestamp: timeEl?.getAttribute('datetime') || null,
          likes: ariaCount('[data-testid="like"]'),
          retweets: ariaCount('[data-testid="retweet"]'),
          replies: ariaCount('[data-testid="reply"]'),
          views: ariaCount('a[href*="/analytics"]'),
          url: linkEl?.href || null,
          platform: 'twitter',
        };
      }).filter(t => t.id);
    });

    const prevSize = tweets.size;
    tweetData.forEach((t) => tweets.set(t.id, t));

    if (onProgress) {
      onProgress({ scraped: tweets.size, limit });
    }

    if (tweets.size === prevSize) {
      retries++;
    } else {
      retries = 0;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomDelay(1500, 3000);
  }

  return Array.from(tweets.values()).slice(0, limit);
}

// ============================================================================
// Thread Scraper
// ============================================================================
// TweetDetail GraphQL helpers (shared by scrapeThread and scrapePost)
// ============================================================================

/**
 * Fetch TweetDetail GraphQL API from the page context using session cookies.
 * The page must already be on x.com (for cookies to be available).
 * Includes a human-like delay before each call.
 */
async function fetchTweetDetail(page, tweetId, retries = 2) {
  await randomDelay(2000, 5000);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await page.evaluate(async (id) => {
      const ct0 = document.cookie.match(/ct0=([^;]+)/)?.[1];
      if (!ct0) return { error: 'no_ct0' };
      const variables = JSON.stringify({
        focalTweetId: id, with_rux_injections: false, rankingMode: 'Relevance',
        includePromotedContent: false, withCommunity: true,
        withQuickPromoteEligibilityTweetFields: true, withBirdwatchNotes: true, withVoice: true,
      });
      const features = JSON.stringify({
        rweb_video_screen_enabled: false, responsive_web_graphql_timeline_navigation_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        creator_subscriptions_tweet_preview_api_enabled: true,
        longform_notetweets_consumption_enabled: true,
        responsive_web_twitter_article_tweet_consumption_enabled: true,
        responsive_web_edit_tweet_api_enabled: true,
        graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
        view_counts_everywhere_api_enabled: true,
        freedom_of_speech_not_reach_fetch_enabled: true,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
        longform_notetweets_rich_text_read_enabled: true,
      });
      const url = `https://x.com/i/api/graphql/t66713qxyDI9pc4Jyb6wxQ/TweetDetail?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
      try {
        const resp = await fetch(url, {
          headers: {
            'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
            'x-csrf-token': ct0, 'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session',
          },
          credentials: 'include',
        });
        if (resp.status === 429) return { error: 'rate_limited', status: 429 };
        if (!resp.ok) return { error: 'http_error', status: resp.status };
        return await resp.json();
      } catch (e) { return { error: 'fetch_failed', message: e.message }; }
    }, tweetId);

    // Success — has data, not an error object
    if (result && !result.error) return result;

    // No ct0 — page might need a refresh to get fresh cookies
    if (result?.error === 'no_ct0') {
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
      await randomDelay(3000, 5000);
      continue;
    }

    // Rate limited — back off and retry
    if (result?.error === 'rate_limited') {
      await randomDelay(10000 + attempt * 15000, 20000 + attempt * 20000);
      continue;
    }

    // Other errors — retry with shorter backoff
    if (attempt < retries) {
      await randomDelay(5000, 10000);
    }
  }

  return null;
}

/** Extract timeline entries from a TweetDetail GraphQL response. */
function extractEntries(graphqlData) {
  const instructions = graphqlData?.data?.threaded_conversation_with_injections_v2?.instructions || [];
  const entries = [];
  for (const inst of instructions) {
    if (inst.entries) entries.push(...inst.entries);
  }
  return entries;
}

/** Unwrap TweetWithVisibilityResults wrapper. */
function unwrapResult(result) {
  if (result?.__typename === 'TweetWithVisibilityResults') return result.tweet;
  return result;
}

/** Get screen_name from a user result (handles both new core and legacy paths). */
function getScreenName(result) {
  const user = result?.core?.user_results?.result;
  return user?.core?.screen_name || user?.legacy?.screen_name || '';
}

/**
 * Parse rich data from a single tweet GraphQL result.
 * Does NOT recurse into quoted tweets — returns quotedTweetId for the caller to handle.
 */
function parseTweetResult(result) {
  result = unwrapResult(result);
  if (!result?.legacy) return null;

  const legacy = result.legacy;
  const author = getScreenName(result);
  const text = result.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || '';

  // Media: images and videos
  const media = (legacy.extended_entities?.media || []).map(m => {
    const item = { type: m.type, url: m.media_url_https };
    if (m.type === 'video' || m.type === 'animated_gif') {
      const best = m.video_info?.variants
        ?.filter(v => v.content_type === 'video/mp4')
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (best) item.videoUrl = best.url;
    }
    return item;
  });

  // Article (X Articles — long-form posts)
  let article = null;
  if (result.article?.article_results?.result) {
    const a = result.article.article_results.result;
    article = {
      id: a.rest_id || null,
      title: a.title || null,
      coverImage: a.cover_media?.media_info?.original_img_url || null,
      url: `https://x.com/${author}/article/${result.rest_id}`,
    };
  }

  // Card (link previews — external URLs)
  let card = null;
  if (result.card?.legacy?.binding_values) {
    const vals = {};
    for (const v of result.card.legacy.binding_values) {
      vals[v.key] = v.value?.string_value || v.value?.scribe_value?.value || v.value?.image_value?.url || '';
    }
    if (vals.title || vals.card_url) {
      card = { title: vals.title || '', description: vals.description || '', url: vals.card_url || '', image: vals.thumbnail_image_original || '' };
    }
  }

  // URLs: external links in tweet text (from both legacy and note_tweet entities)
  const rawUrls = [
    ...(legacy.entities?.urls || []),
    ...(result.note_tweet?.note_tweet_results?.result?.entity_set?.urls || []),
  ];
  const urls = rawUrls
    .map(u => ({ url: u.expanded_url || u.url || '', display: u.display_url || '' }))
    .filter(u => u.url && !u.url.includes('x.com/') && !u.url.includes('twitter.com/'));

  // Quoted tweet ID (for recursive fetching — not parsed from this response)
  const quotedTweetId = result.quoted_status_result?.result?.rest_id || legacy.quoted_status_id_str || null;

  return {
    id: result.rest_id,
    author,
    text,
    timestamp: legacy.created_at ? new Date(legacy.created_at).toISOString() : null,
    url: `https://x.com/${author}/status/${result.rest_id}`,
    media,
    article,
    card,
    urls: urls.length > 0 ? urls : undefined,
    quotedTweetId,
    inReplyTo: legacy.in_reply_to_status_id_str || null,
    replies: legacy.reply_count || 0,
    retweets: legacy.retweet_count || 0,
    likes: legacy.favorite_count || 0,
    views: result.views?.count || '0',
    platform: 'twitter',
  };
}

/**
 * From a list of entries, collect all tweets by a given author and filter
 * to the self-reply thread chain (root tweet + author replying to themselves).
 */
function parseThreadFromEntries(entries, mainAuthor, mainTweetId) {
  const candidates = new Map();

  for (const entry of entries) {
    const result = unwrapResult(entry.content?.itemContent?.tweet_results?.result);
    if (result && getScreenName(result).toLowerCase() === mainAuthor.toLowerCase()) {
      const parsed = parseTweetResult(result);
      if (parsed) candidates.set(parsed.id, parsed);
    }
    for (const item of (entry.content?.items || [])) {
      const r = unwrapResult(item.item?.itemContent?.tweet_results?.result);
      if (r && getScreenName(r).toLowerCase() === mainAuthor.toLowerCase()) {
        const parsed = parseTweetResult(r);
        if (parsed) candidates.set(parsed.id, parsed);
      }
    }
  }

  const threadIds = new Set(candidates.keys());
  return Array.from(candidates.values())
    .filter(t => t.id === mainTweetId || (t.inReplyTo && threadIds.has(t.inReplyTo)))
    .sort((a, b) => {
      const ta = t => t.timestamp ? new Date(t.timestamp).getTime() : 0;
      return ta(a) - ta(b);
    });
}

// ============================================================================
// Thread Scraper
// ============================================================================

/**
 * Scrape a full tweet thread (author's self-reply chain).
 */
export async function scrapeThread(page, tweetUrl) {
  const mainTweetId = new URL(tweetUrl).pathname.match(/status\/(\d+)/)?.[1] || null;
  const mainAuthor = new URL(tweetUrl).pathname.split('/').filter(Boolean)[0] || null;
  if (!mainTweetId || !mainAuthor) return [];

  await page.goto(tweetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  checkAuth(page);
  await randomDelay(2000, 3000);

  const graphqlData = await fetchTweetDetail(page, mainTweetId);
  if (!graphqlData) return [];

  const entries = extractEntries(graphqlData);
  const thread = parseThreadFromEntries(entries, mainAuthor, mainTweetId);

  // Strip internal fields for backward compatibility
  return thread.map(({ inReplyTo, quotedTweetId, media, article, card, ...rest }) => rest);
}

// ============================================================================
// Post Scraper (rich data + recursive quoted tweets)
// ============================================================================

/**
 * Scrape a single post or thread with full rich data.
 *
 * Returns the thread (1 tweet if single post, N if thread) with rich data
 * per tweet: text, media, article, card, engagement, and recursively
 * resolved quoted posts (which may themselves be threads).
 *
 * @param {import('puppeteer').Page} page
 * @param {string} tweetUrl
 * @param {number} [maxDepth=5] - Max recursion depth for nested quote tweets
 */
export async function scrapePost(page, tweetUrl, maxDepth = 5) {
  const mainTweetId = new URL(tweetUrl).pathname.match(/status\/(\d+)/)?.[1] || null;
  const mainAuthor = new URL(tweetUrl).pathname.split('/').filter(Boolean)[0] || null;
  if (!mainTweetId || !mainAuthor) throw new Error('Invalid tweet URL');

  // Ensure we're on x.com for cookie access
  if (!page.url().includes('x.com')) {
    await page.goto('https://x.com', { waitUntil: 'networkidle2', timeout: 30000 });
    checkAuth(page);
    await randomDelay(2000, 3000);
  }

  return _scrapePostRecursive(page, mainTweetId, mainAuthor, maxDepth, 0);
}

async function _scrapePostRecursive(page, tweetId, author, maxDepth, depth) {
  const graphqlData = await fetchTweetDetail(page, tweetId);
  if (!graphqlData) return { thread: [], error: 'fetchTweetDetail returned null after retries' };

  // Check if the API returned an error object (shouldn't happen after retries, but just in case)
  if (graphqlData.error) return { thread: [], error: graphqlData.error };

  const entries = extractEntries(graphqlData);
  const thread = parseThreadFromEntries(entries, author, tweetId);
  if (thread.length === 0) return { thread: [], error: `no tweets found for @${author} in TweetDetail response (${entries.length} entries)` };

  // For each thread tweet, resolve its quoted post recursively
  for (const tweet of thread) {
    if (tweet.quotedTweetId && depth < maxDepth) {
      // Fetch the quoted tweet as a focal tweet to get its full data (thread + its own QTs)
      const qtData = await fetchTweetDetail(page, tweet.quotedTweetId);
      if (qtData) {
        const qtEntries = extractEntries(qtData);
        // Find the focal tweet result to get its author
        const focalEntry = qtEntries.find(e =>
          e.entryId?.includes(tweet.quotedTweetId));
        const focalResult = unwrapResult(
          focalEntry?.content?.itemContent?.tweet_results?.result);
        const qtAuthor = focalResult ? getScreenName(focalResult) : '';

        if (qtAuthor) {
          tweet.quotedPost = await _scrapePostRecursive(
            page, tweet.quotedTweetId, qtAuthor, maxDepth, depth + 1);
        }
      }
    }
    // Clean up internal field
    delete tweet.quotedTweetId;
    delete tweet.inReplyTo;
  }

  return { thread };
}

// ============================================================================
// Liked Tweets Scraper (a user's liked tweets page)
// ============================================================================

/**
 * Scrape a user's liked tweets via the Likes GraphQL API.
 *
 * Uses cursor-based pagination — no DOM scraping or scroll limits.
 * Writes results incrementally to a JSONL file so progress survives
 * crashes and memory stays bounded for large pulls.
 *
 * Returns { file, count, username, dateRange } — the caller reads the
 * file for the full data.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} username
 * @param {object} options
 * @param {number} [options.limit=50] - Max tweets to return
 * @param {string} [options.from] - Only include likes from this date onward (stops when older)
 * @param {string} [options.to] - Only include likes up to this date (skips newer)
 */
export async function scrapeLikedTweets(page, username, options = {}) {
  const { limit = 50, from, to } = options;

  if (!username) throw new Error('Username is required for scrapeLikedTweets');

  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  if (fromDate && isNaN(fromDate.getTime())) throw new Error(`Invalid "from" date: ${from}`);
  if (toDate && isNaN(toDate.getTime())) throw new Error(`Invalid "to" date: ${to}`);

  // Ensure we're on x.com for cookie access
  if (!page.url().includes('x.com')) {
    await page.goto('https://x.com', { waitUntil: 'networkidle2', timeout: 30000 });
    checkAuth(page);
    await randomDelay(2000, 3000);
  }

  // Resolve numeric userId from username (see USER_BY_SCREEN_NAME_* above).
  const userId = await resolveUserId(page, username);

  // Set up JSONL output file
  const exportDir = `${process.env.HOME || '/tmp'}/.xactions/exports`;
  await fs.mkdir(exportDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = `${exportDir}/likes-${username}-${ts}.jsonl`;

  let count = 0;
  let cursor = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let emptyPages = 0;
  let passedFromDate = false;

  while (count < limit && emptyPages < 3 && !passedFromDate) {
    await randomDelay(2000, 5000);

    const pageData = await page.evaluate(async ({ userId, cursor, pageSize }) => {
      const ct0 = document.cookie.match(/ct0=([^;]+)/)?.[1];
      if (!ct0) return null;
      const variables = { userId, count: pageSize, includePromotedContent: false, withClientEventToken: false, withBirdwatchNotes: false, withVoice: true };
      if (cursor) variables.cursor = cursor;
      const features = {
        rweb_video_screen_enabled: false, responsive_web_graphql_timeline_navigation_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        creator_subscriptions_tweet_preview_api_enabled: true,
        longform_notetweets_consumption_enabled: true,
        responsive_web_twitter_article_tweet_consumption_enabled: true,
        responsive_web_edit_tweet_api_enabled: true,
        graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
        view_counts_everywhere_api_enabled: true,
        freedom_of_speech_not_reach_fetch_enabled: true,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
        longform_notetweets_rich_text_read_enabled: true,
      };
      const url = `https://x.com/i/api/graphql/KPuet6dGbC8LB2sOLx7tZQ/Likes?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`;
      try {
        const resp = await fetch(url, {
          headers: { 'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA', 'x-csrf-token': ct0, 'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session' },
          credentials: 'include',
        });
        return await resp.json();
      } catch { return null; }
    }, { userId, cursor, pageSize: Math.min(20, limit - count) });

    if (!pageData) { emptyPages++; continue; }

    // Extract entries from timeline (path: data.user.result.timeline.timeline.instructions)
    const instructions = pageData?.data?.user?.result?.timeline?.timeline?.instructions || [];
    const entries = [];
    for (const inst of instructions) {
      if (inst.entries) entries.push(...inst.entries);
    }

    // Find cursor for next page
    const cursorEntry = entries.find(e => e.entryId?.startsWith('cursor-bottom'));
    cursor = cursorEntry?.content?.value || null;

    // Parse tweets
    const batch = [];
    for (const entry of entries) {
      const result = entry.content?.itemContent?.tweet_results?.result;
      if (!result) continue;
      const parsed = parseTweetResult(result);
      if (!parsed) continue;

      const tweetDate = parsed.timestamp ? new Date(parsed.timestamp) : null;
      if (tweetDate) {
        if (fromDate && tweetDate < fromDate) { passedFromDate = true; break; }
        if (toDate && tweetDate > toDate) continue;
      }

      // Clean internal fields
      delete parsed.quotedTweetId;
      delete parsed.inReplyTo;

      if (!firstTimestamp && parsed.timestamp) firstTimestamp = parsed.timestamp;
      if (parsed.timestamp) lastTimestamp = parsed.timestamp;
      batch.push(parsed);
      count++;
      if (count >= limit) break;
    }

    if (batch.length > 0) {
      const lines = batch.map(t => JSON.stringify(t)).join('\n') + '\n';
      await fs.appendFile(filePath, lines);
      emptyPages = 0;
    } else {
      emptyPages++;
    }

    if (!cursor) break;
  }

  return { file: filePath, count, username, dateRange: { from: firstTimestamp, to: lastTimestamp } };
}

// ============================================================================
// Timeline discovery: likes, all bookmarks, one bookmark folder
// ============================================================================
//
// One loop lists a timeline page by page, then deep-reads the listed posts.
// Each operation's queryId, feature switches and field toggles come from
// upstream's resolver (./http/endpoints.js: the discovery cache, then the
// generated table). The URL is built in Node and fetched inside the logged-in
// page, so the session cookie and the headers are the ones likes always used.

/** The likes queryId this path used before the resolver: the last fallback. */
const LIKES_LEGACY_QUERY_ID = 'KPuet6dGbC8LB2sOLx7tZQ';

/** The feature set sent with the legacy likes queryId. */
const LIKES_LEGACY_FEATURES = Object.freeze({
  rweb_video_screen_enabled: false, responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
});

/**
 * Upstream keys this path resolves. `Likes` is deliberately absent: upstream
 * maps that key to `Favoriters`, the users who liked one post, so it would
 * silently fetch the wrong timeline. The user's likes are `UserLikes`.
 */
const TIMELINE_KEYS = Object.freeze(['UserLikes', 'BookmarkTimeline', 'BookmarkFolderTimeline', 'BookmarkFoldersSlice']);

/** An HTTP error, or a 200 whose body has none of the data the operation returns. */
export class TimelineRequestError extends Error {
  constructor(operationName, status, body) {
    const head = String(body ?? '').slice(0, 300);
    super(`${operationName}: X answered ${status}: ${head}`);
    this.name = 'TimelineRequestError';
    this.operationName = operationName;
    this.status = status;
    this.bodyHead = head;
  }
}

/**
 * The request shapes to try for one timeline operation, best first.
 *
 * Resolution never touches the network. Candidates, in order: the queryId in
 * the discovery cache, the generated (pinned) table's, and for likes the
 * legacy queryId with its feature set. A discovery that failed or never ran
 * leaves the pinned table first. A candidate is tried only while the
 * operation has not yet answered (see requestOperation).
 *
 * @param {'UserLikes'|'BookmarkTimeline'|'BookmarkFolderTimeline'|'BookmarkFoldersSlice'} key
 * @returns {{queryId: string, operationName: string, source: string, features: object, fieldToggles?: object}[]}
 */
export function resolveTimelineOperation(key) {
  if (!TIMELINE_KEYS.includes(key)) {
    const hint = key === 'Likes' ? " ('Likes' resolves to Favoriters, the users who liked one post; use 'UserLikes')" : '';
    throw new Error(`resolveTimelineOperation: unsupported key ${key}${hint}`);
  }
  const candidates = [];
  let failure = null;
  try {
    // resolveGraphQL supplies the operation name. Its queryId is not used:
    // it looks the operation name up again through the key table, where the
    // name `Likes` is the key for Favoriters, so for UserLikes it returns the
    // Favoriters queryId. The name is looked up directly instead: the
    // discovery cache first, then the generated table.
    const { operationName } = resolveGraphQL(key);
    const cached = loadQueryIdCache()?.operations?.[operationName]?.queryId;
    const pinned = UPSTREAM_OPERATIONS[operationName]?.queryId;
    const toggles = operationFieldToggles(operationName);
    for (const [queryId, source] of [[cached, 'cache'], [pinned, 'hardcoded']]) {
      if (!queryId || candidates.some((c) => c.queryId === queryId)) continue;
      candidates.push({
        queryId,
        operationName,
        source,
        features: operationFeatures(operationName),
        fieldToggles: Object.keys(toggles).length ? toggles : undefined,
      });
    }
  } catch (e) {
    failure = e;
  }
  if (key === 'UserLikes' && !candidates.some((c) => c.queryId === LIKES_LEGACY_QUERY_ID)) {
    candidates.push({
      queryId: LIKES_LEGACY_QUERY_ID,
      operationName: 'Likes',
      source: 'legacy',
      features: { ...LIKES_LEGACY_FEATURES },
      fieldToggles: undefined,
    });
  }
  if (candidates.length === 0) throw failure || new Error(`No queryId for ${key}`);
  return candidates;
}

/** GET a GraphQL URL from inside the logged-in page, with the likes headers. */
async function fetchInPage(page, url) {
  return page.evaluate(async ({ url, bearer }) => {
    const ct0 = document.cookie.match(/ct0=([^;]+)/)?.[1];
    if (!ct0) return { error: 'no_ct0' };
    try {
      const resp = await fetch(url, {
        headers: { 'authorization': `Bearer ${bearer}`, 'x-csrf-token': ct0, 'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session' },
        credentials: 'include',
      });
      return { status: resp.status, text: await resp.text() };
    } catch (e) { return { error: 'fetch_failed', message: String(e) }; }
  }, { url, bearer: BEARER_TOKEN });
}

/**
 * One request of a timeline operation.
 *
 * Returns `{data, extracted}` on success and null on a transport failure (no
 * ct0 cookie, fetch threw). A 429 is retried twice with backoff. An HTTP error,
 * or a body `extract` finds nothing in, throws TimelineRequestError — unless
 * the operation has not answered yet and a later candidate queryId remains,
 * in which case that candidate is tried.
 *
 * @param {object} page
 * @param {{candidates: object[], index: number, locked: boolean}} op
 * @param {object} variables
 * @param {(data: object) => any} extract
 */
async function requestOperation(page, op, variables, extract) {
  for (;;) {
    const c = op.candidates[op.index];
    const url = buildGraphQLUrl(c.queryId, c.operationName, variables, c.features, c.fieldToggles);
    let res = null;
    for (let attempt = 0; ; attempt++) {
      res = await fetchInPage(page, url);
      if (res?.status === 429 && attempt < 2) {
        await randomDelay(10000 + attempt * 15000, 20000 + attempt * 20000);
        continue;
      }
      break;
    }
    if (!res || res.error) return null;
    let data = null;
    try { data = JSON.parse(res.text); } catch { /* non-JSON body */ }
    const extracted = res.status === 200 && data ? extract(data) : null;
    if (extracted != null) {
      op.locked = true;
      return { data, extracted };
    }
    if (!op.locked && op.index < op.candidates.length - 1) {
      op.index++;
      continue;
    }
    throw new TimelineRequestError(c.operationName, res.status, res.text);
  }
}

/** Likes: `data.user.result.timeline…instructions`, either container name. */
function likesInstructions(data) {
  const result = data?.data?.user?.result;
  return result?.timeline?.timeline?.instructions ??
    result?.timeline_v2?.timeline?.instructions ??
    result?.timeline?.instructions ?? null;
}

/** All bookmarks: `bookmark_timeline_v2`, else `bookmark_timeline`. */
function bookmarkInstructions(data) {
  return data?.data?.bookmark_timeline_v2?.timeline?.instructions ??
    data?.data?.bookmark_timeline?.timeline?.instructions ?? null;
}

/** The first `timeline.instructions` array anywhere in a response. */
function findTimelineInstructions(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node.timeline?.instructions)) return node.timeline.instructions;
  for (const v of Object.values(node)) {
    const found = findTimelineInstructions(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/** One folder: `bookmark_collection_timeline`, else the first instructions array. */
function folderInstructions(data) {
  return data?.data?.bookmark_collection_timeline?.timeline?.instructions ??
    findTimelineInstructions(data?.data);
}

/** The folder slice: `data.viewer.user_results.result.bookmark_collections_slice`. */
function folderSlice(data) {
  const slice = data?.data?.viewer?.user_results?.result?.bookmark_collections_slice;
  return Array.isArray(slice?.items) ? slice : null;
}

/** Tweet ids in a skip file: digit tokens separated by whitespace or commas. */
async function readSkipIds(file) {
  const text = await fs.readFile(file, 'utf8');
  return new Set(text.split(/[\s,]+/).filter((t) => /^\d+$/.test(t)));
}

function parseDateOption(value, name) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) throw new Error(`Invalid "${name}" date: ${value}`);
  return d;
}

async function ensureOnX(page) {
  if (!page.url().includes('x.com')) {
    await page.goto('https://x.com', { waitUntil: 'networkidle2', timeout: 30000 });
    checkAuth(page);
    await randomDelay(2000, 3000);
  }
}

/**
 * Resolve a user's numeric rest_id via UserByScreenName. X rotates both the
 * GraphQL queryId and the required feature flags, so try the current id then
 * the legacy one with the full feature set, and throw X's raw response if
 * neither resolves — a future drift must be diagnosable, not a bare null.
 */
async function resolveUserId(page, username) {
  const resolution = await page.evaluate(async (screenName, FEATURES, QUERY_IDS) => {
    const ct0 = document.cookie.match(/ct0=([^;]+)/)?.[1];
    if (!ct0) return { ok: false, reason: 'no ct0 cookie in page' };
    const variables = JSON.stringify({ screen_name: screenName, withSafetyModeUserFields: true });
    const features = JSON.stringify(FEATURES);
    let last = null;
    for (const qid of QUERY_IDS) {
      const url = `https://x.com/i/api/graphql/${qid}/UserByScreenName?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
      try {
        const resp = await fetch(url, {
          headers: { 'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA', 'x-csrf-token': ct0, 'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session' },
          credentials: 'include',
        });
        const text = await resp.text();
        let data = null; try { data = JSON.parse(text); } catch { /* non-JSON */ }
        const rid = data?.data?.user?.result?.rest_id;
        if (rid) return { ok: true, rest_id: rid, queryId: qid };
        last = { queryId: qid, status: resp.status, body: text.slice(0, 300) };
      } catch (e) { last = { queryId: qid, error: String(e) }; }
    }
    return { ok: false, last };
  }, username, USER_BY_SCREEN_NAME_FEATURES, USER_BY_SCREEN_NAME_QUERY_IDS);

  if (!resolution.ok) {
    throw new Error(`Could not resolve userId for @${username}: ${JSON.stringify(resolution.last || resolution)}`);
  }
  return resolution.rest_id;
}

/**
 * List a timeline, then deep-read the listed posts.
 *
 * Listing runs to the end first (up to `limit`), so a run cut short during
 * the deep reads still leaves a complete listing. `listingComplete` is true
 * when the limit was reached, the `from` date was passed, or the timeline
 * ended (no new bottom cursor, or three pages in a row with no posts); it is
 * false when listing stopped on three transport failures in a row. X ignores
 * the requested `count`, so the listing is capped by `limit` alone.
 *
 * Deep reads go newest first. A listed post whose id is in `skipIds` stays in
 * the shallow file but is neither read nor paused for. At most `maxDeep`
 * posts are read; the rest are counted in `deferredDeep`.
 *
 * Files: `<stem>-<ts>.jsonl` (shallow) and `<stem>-<ts>-deep.jsonl` (deep).
 * The deep file is created with its first line. The shallow file is appended
 * page by page (created with its first line), or with `shallowAtEnd` written
 * once when listing ends, even when empty.
 *
 * @param {object} page logged-in Puppeteer page
 * @param {object} cfg
 * @param {'like'|'bookmark'} cfg.kind
 * @param {string|null} cfg.scope `all` or a folder id for bookmarks; null for likes
 * @param {string} cfg.username
 * @param {string} cfg.stem file-name stem, e.g. `likes-<user>`
 * @param {number} [cfg.limit=50]
 * @param {string} cfg.operation key for resolveTimelineOperation
 * @param {(cursor: string|null, remaining: number) => object} cfg.variables
 * @param {(data: object) => object[]|null} cfg.instructionsOf
 * @param {string} [cfg.exportDir] default `$XACTIONS_HOME/exports` (`~/.xactions/exports`)
 * @param {string} [cfg.skipIds] path to a file of tweet ids not to deep-read
 * @param {number} [cfg.maxDeep] most deep reads this call makes
 * @param {string} [cfg.from] only posts from this date onward (stops listing)
 * @param {string} [cfg.to] only posts up to this date
 * @param {boolean} [cfg.shallowAtEnd=false]
 * @param {(listed: object[]) => Promise<void>} [cfg.verifyListing] may throw before the shallow file is written
 */
export async function discoverTimeline(page, cfg) {
  const {
    kind, scope = null, username, stem, limit = 50, operation, variables, instructionsOf,
    exportDir, skipIds, maxDeep, from, to, shallowAtEnd = false, verifyListing,
  } = cfg;

  const fromDate = parseDateOption(from, 'from');
  const toDate = parseDateOption(to, 'to');
  await ensureOnX(page);

  const op = { candidates: resolveTimelineOperation(operation), index: 0, locked: false };
  const skip = skipIds ? await readSkipIds(skipIds) : new Set();
  const deepCap = maxDeep == null ? Infinity : Math.max(0, Number(maxDeep));

  const dir = exportDir || path.join(sessionDir(), 'exports');
  await fs.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const shallowFile = path.join(dir, `${stem}-${ts}.jsonl`);
  const deepFile = path.join(dir, `${stem}-${ts}-deep.jsonl`);

  // ---- Listing ----
  const listed = [];
  let cursor = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let emptyPages = 0;
  let transportFailures = 0;
  let passedFromDate = false;
  let ended = false;

  while (listed.length < limit && !passedFromDate) {
    // Pause between pages — like scrolling through the feed
    await randomDelay(3000, 8000);

    const res = await requestOperation(page, op, variables(cursor, limit - listed.length), instructionsOf);
    if (!res) {
      if (++transportFailures >= 3) break;
      continue;
    }
    transportFailures = 0;

    const entries = [];
    for (const inst of res.extracted) {
      if (inst.entries) entries.push(...inst.entries);
      else if (inst.entry) entries.push(inst.entry);
    }
    const nextCursor = entries.find((e) => e.entryId?.startsWith('cursor-bottom'))?.content?.value || null;

    const batch = [];
    for (const entry of entries) {
      const result = entry.content?.itemContent?.tweet_results?.result;
      if (!result) continue;
      const parsed = parseTweetResult(result);
      if (!parsed) continue;

      const tweetDate = parsed.timestamp ? new Date(parsed.timestamp) : null;
      if (tweetDate) {
        if (fromDate && tweetDate < fromDate) { passedFromDate = true; break; }
        if (toDate && tweetDate > toDate) continue;
      }

      delete parsed.quotedTweetId;
      delete parsed.inReplyTo;

      if (!firstTimestamp && parsed.timestamp) firstTimestamp = parsed.timestamp;
      if (parsed.timestamp) lastTimestamp = parsed.timestamp;
      batch.push(parsed);
      if (listed.length + batch.length >= limit) break;
    }

    listed.push(...batch);
    if (batch.length > 0) {
      if (!shallowAtEnd) await fs.appendFile(shallowFile, batch.map((t) => JSON.stringify(t)).join('\n') + '\n');
      emptyPages = 0;
    } else {
      emptyPages++;
    }

    if (!nextCursor || nextCursor === cursor || emptyPages >= 3) { ended = true; break; }
    cursor = nextCursor;
  }

  const listingComplete = listed.length >= limit || passedFromDate || ended;
  if (verifyListing) await verifyListing(listed);
  if (shallowAtEnd) {
    await fs.writeFile(shallowFile, listed.length ? listed.map((t) => JSON.stringify(t)).join('\n') + '\n' : '');
  }

  // ---- Deep reads, newest first ----
  let deepCount = 0;
  let attempted = 0;
  let skippedDeep = 0;
  let deferredDeep = 0;
  for (const tweet of listed) {
    if (skip.has(String(tweet.id))) { skippedDeep++; continue; }
    if (attempted >= deepCap) { deferredDeep++; continue; }
    attempted++;

    // Pause before tapping in — decision time
    await randomDelay(2000, 5000, 'pre-read');

    try {
      const tweetUrl = tweet.url;
      if (!tweetUrl) continue;
      const author = new URL(tweetUrl).pathname.split('/').filter(Boolean)[0];
      const tweetId = new URL(tweetUrl).pathname.match(/status\/(\d+)/)?.[1];
      if (!tweetId || !author) continue;

      const deepData = await _scrapePostRecursive(page, tweetId, author, 5, 0);
      if (deepData.thread.length > 0) {
        await fs.appendFile(deepFile, JSON.stringify(deepData) + '\n');
        deepCount++;
      }
    } catch {}

    // Pause after reading — absorbing the content
    await randomDelay(5000, 15000, 'post-read');
  }

  const used = op.candidates[op.index];
  return {
    kind,
    scope,
    username,
    file: shallowFile,
    deepFile,
    count: listed.length,
    deepCount,
    skippedDeep,
    deferredDeep,
    listingComplete,
    queryId: used.queryId,
    queryIdSource: used.source,
    dateRange: { from: firstTimestamp, to: lastTimestamp },
  };
}

/**
 * Fetch liked tweets and deep-read each one with human-like pacing.
 * Produces two JSONL files:
 *   - likes index (summary per tweet from the Likes API)
 *   - deep reads (full scrapePost output per tweet)
 *
 * @param {import('puppeteer').Page} page
 * @param {string} username
 * @param {object} options
 * @param {number} [options.limit=50] - Max tweets
 * @param {string} [options.from] - Only likes from this date onward
 * @param {string} [options.to] - Only likes up to this date
 * @param {string} [options.skipIds] - File of tweet ids to list but not deep-read
 * @param {number} [options.maxDeep] - Most deep reads this call makes
 * @param {string} [options.exportDir] - Default `$XACTIONS_HOME/exports`
 */
export async function discoverLikes(page, username, options = {}) {
  const { limit = 50, from, to, skipIds, maxDeep, exportDir } = options;

  if (!username) throw new Error('Username is required');
  parseDateOption(from, 'from');
  parseDateOption(to, 'to');

  await ensureOnX(page);
  const userId = await resolveUserId(page, username);

  const r = await discoverTimeline(page, {
    kind: 'like',
    scope: null,
    username,
    stem: `likes-${username}`,
    limit, from, to, skipIds, maxDeep, exportDir,
    operation: 'UserLikes',
    variables: (cursor, remaining) => {
      const v = { userId, count: Math.min(20, remaining), includePromotedContent: false, withClientEventToken: false, withBirdwatchNotes: false, withVoice: true };
      if (cursor) v.cursor = cursor;
      return v;
    },
    instructionsOf: likesInstructions,
  });

  return {
    likesFile: r.file,
    deepReadsFile: r.deepFile,
    likesCount: r.count,
    deepReadsCount: r.deepCount,
    username,
    dateRange: r.dateRange,
    kind: r.kind,
    scope: r.scope,
    skippedDeep: r.skippedDeep,
    deferredDeep: r.deferredDeep,
    listingComplete: r.listingComplete,
    queryId: r.queryId,
    queryIdSource: r.queryIdSource,
  };
}

function folderNotFound(folderId, cause) {
  const detail = cause ? ` (X answered ${cause.status}: ${cause.bodyHead})` : '';
  return Object.assign(
    new Error(`FOLDER_NOT_FOUND: bookmark folder ${folderId} is not among this account's folders${detail}`),
    { code: 'FOLDER_NOT_FOUND', folderId, status: cause?.status ?? null },
  );
}

/**
 * Throw FOLDER_NOT_FOUND when the account's folder list lacks `folderId`.
 * Returns quietly when the list itself cannot be read: the caller then
 * reports its own outcome rather than a guess.
 */
async function assertFolderExists(page, folderId, cause) {
  let folders;
  try { folders = await listBookmarkFolders(page); } catch { return; }
  if (!folders.some((f) => f.id === folderId)) throw folderNotFound(folderId, cause);
}

/**
 * Fetch bookmarks — all of them, or one folder — and deep-read each one.
 *
 * Files: `bookmarks-<user>-<scope>-<ts>.jsonl` and `…-deep.jsonl`, where
 * `<scope>` is `all` or the folder id. The shallow file is written when
 * listing ends, even when it is empty; the deep file appears with its first
 * line. A folder id the account does not have throws with
 * `code: 'FOLDER_NOT_FOUND'`, whether X answered with an error or with an
 * empty timeline.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} username used in the file names
 * @param {object} [options]
 * @param {string} [options.scope='all'] `all` or a bookmark folder id
 * @param {number} [options.limit=50]
 * @param {string} [options.skipIds]
 * @param {number} [options.maxDeep]
 * @param {string} [options.exportDir]
 */
export async function discoverBookmarks(page, username, options = {}) {
  const { scope = 'all', limit = 50, skipIds, maxDeep, exportDir } = options;
  if (!username) throw new Error('Username is required');
  const folderId = String(scope);
  if (folderId !== 'all' && !/^\d+$/.test(folderId)) {
    throw new Error(`Invalid bookmark scope "${scope}": use "all" or a numeric folder id`);
  }
  const isFolder = folderId !== 'all';

  let r;
  try {
    r = await discoverTimeline(page, {
      kind: 'bookmark',
      scope: folderId,
      username,
      stem: `bookmarks-${username}-${folderId}`,
      limit, skipIds, maxDeep, exportDir,
      shallowAtEnd: true,
      operation: isFolder ? 'BookmarkFolderTimeline' : 'BookmarkTimeline',
      variables: (cursor) => {
        const v = isFolder ? { bookmark_collection_id: folderId, count: 20 } : { count: 20 };
        if (cursor) v.cursor = cursor;
        v.includePromotedContent = false;
        return v;
      },
      instructionsOf: isFolder ? folderInstructions : bookmarkInstructions,
      verifyListing: isFolder
        ? async (listed) => { if (listed.length === 0) await assertFolderExists(page, folderId, null); }
        : undefined,
    });
  } catch (e) {
    if (isFolder && e instanceof TimelineRequestError) await assertFolderExists(page, folderId, e);
    throw e;
  }

  return {
    bookmarksFile: r.file,
    deepReadsFile: r.deepFile,
    bookmarksCount: r.count,
    deepReadsCount: r.deepCount,
    username,
    dateRange: r.dateRange,
    kind: r.kind,
    scope: r.scope,
    skippedDeep: r.skippedDeep,
    deferredDeep: r.deferredDeep,
    listingComplete: r.listingComplete,
    queryId: r.queryId,
    queryIdSource: r.queryIdSource,
  };
}

/**
 * The account's bookmark folders, `[{id, name}]`, in X's order.
 *
 * Pages through `slice_info.next_cursor` when X sends one. Names are returned
 * as X sends them, trailing spaces included; ids are the identity.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<{id: string, name: string}[]>}
 */
export async function listBookmarkFolders(page) {
  await ensureOnX(page);
  const op = { candidates: resolveTimelineOperation('BookmarkFoldersSlice'), index: 0, locked: false };
  const folders = [];
  const seen = new Set();
  let cursor = null;
  for (let pageNo = 0; pageNo < 50; pageNo++) {
    let res = null;
    for (let attempt = 0; attempt < 3 && !res; attempt++) {
      res = await requestOperation(page, op, cursor ? { cursor } : {}, folderSlice);
    }
    if (!res) throw new Error('BookmarkFoldersSlice: the request failed inside the page (no ct0 cookie, or fetch threw)');
    for (const item of res.extracted.items) {
      if (item?.id != null) folders.push({ id: String(item.id), name: item.name ?? '' });
    }
    const next = res.extracted.slice_info?.next_cursor || null;
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
    await randomDelay(1000, 2500);
  }
  return folders;
}

// ============================================================================
// Likes Scraper (who liked a specific tweet)
// ============================================================================

/**
 * Scrape users who liked a tweet
 */
export async function scrapeLikes(page, tweetUrl, options = {}) {
  const { limit = 100 } = options;
  
  const likesUrl = tweetUrl.replace(/\/status\//, '/status/') + '/likes';
  await page.goto(likesUrl, { waitUntil: 'networkidle2' });
  await randomDelay();

  const users = new Map();
  let retries = 0;
  const maxRetries = 10;

  while (users.size < limit && retries < maxRetries) {
    const userData = await page.evaluate(() => {
      const cells = document.querySelectorAll('[data-testid="UserCell"]');
      return Array.from(cells).map((cell) => {
        const link = cell.querySelector('a[href^="/"]');
        const nameEl = cell.querySelector('[dir="ltr"] > span');
        const bioEl = cell.querySelector('[data-testid="UserDescription"]');

        const href = link?.getAttribute('href') || '';
        const username = href.split('/')[1];

        return {
          username,
          name: nameEl?.textContent || null,
          bio: bioEl?.textContent || null,
        };
      }).filter(u => u.username && !u.username.includes('?'));
    });

    const prevSize = users.size;
    userData.forEach((u) => users.set(u.username, u));

    if (users.size === prevSize) {
      retries++;
    } else {
      retries = 0;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomDelay(1500, 3000);
  }

  return Array.from(users.values()).slice(0, limit);
}

// ============================================================================
// Hashtag Scraper
// ============================================================================

/**
 * Scrape tweets for a hashtag
 */
export async function scrapeHashtag(page, hashtag, options = {}) {
  const { limit = 100, filter = 'latest' } = options;
  
  const tag = hashtag.startsWith('#') ? hashtag.slice(1) : hashtag;
  return searchTweets(page, `#${tag}`, { limit, filter });
}

// ============================================================================
// Media Scraper
// ============================================================================

/**
 * Scrape media (images/videos) from a user
 */
export async function scrapeMedia(page, username, options = {}) {
  const { limit = 100 } = options;
  
  await page.goto(`https://x.com/${username}/media`, { waitUntil: 'networkidle2' });
  await randomDelay();

  const media = [];
  let retries = 0;
  const maxRetries = 10;

  while (media.length < limit && retries < maxRetries) {
    const newMedia = await page.evaluate(() => {
      const items = document.querySelectorAll('article[data-testid="tweet"]');
      return Array.from(items).flatMap((article) => {
        const images = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img'))
          .map(img => ({
            type: 'image',
            url: img.src.replace(/&name=\w+/, '&name=large'),
          }));
        
        const videos = article.querySelector('[data-testid="videoPlayer"]')
          ? [{ type: 'video', url: article.querySelector('a[href*="/status/"]')?.href }]
          : [];
        
        const tweetUrl = article.querySelector('a[href*="/status/"]')?.href;
        
        return [...images, ...videos].map(m => ({
          ...m,
          tweetUrl,
        }));
      });
    });

    const prevLength = media.length;
    newMedia.forEach((m) => {
      if (!media.find(existing => existing.url === m.url)) {
        media.push(m);
      }
    });

    if (media.length === prevLength) {
      retries++;
    } else {
      retries = 0;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomDelay(1500, 3000);
  }

  return media.slice(0, limit);
}

// ============================================================================
// List Scraper
// ============================================================================

/**
 * Scrape members of a Twitter list
 */
export async function scrapeListMembers(page, listUrl, options = {}) {
  const { limit = 500 } = options;
  
  const membersUrl = listUrl.endsWith('/members') ? listUrl : `${listUrl}/members`;
  await page.goto(membersUrl, { waitUntil: 'networkidle2' });
  await randomDelay();

  const members = new Map();
  let retries = 0;
  const maxRetries = 10;

  while (members.size < limit && retries < maxRetries) {
    const users = await page.evaluate(() => {
      const cells = document.querySelectorAll('[data-testid="UserCell"]');
      return Array.from(cells).map((cell) => {
        const link = cell.querySelector('a[href^="/"]');
        const nameEl = cell.querySelector('[dir="ltr"] > span');
        const bioEl = cell.querySelector('[data-testid="UserDescription"]');

        const href = link?.getAttribute('href') || '';
        const username = href.split('/')[1];

        return {
          username,
          name: nameEl?.textContent || null,
          bio: bioEl?.textContent || null,
        };
      }).filter(u => u.username && !u.username.includes('?'));
    });

    const prevSize = members.size;
    users.forEach((u) => members.set(u.username, u));

    if (members.size === prevSize) {
      retries++;
    } else {
      retries = 0;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomDelay(1500, 3000);
  }

  return Array.from(members.values()).slice(0, limit);
}

// ============================================================================
// Bookmarks Scraper
// ============================================================================

/**
 * Scrape bookmarked tweets (requires login)
 */
export async function scrapeBookmarks(page, options = {}) {
  const { limit = 100, scrollDelay = 2000 } = options;
  
  await gotoAndRender(page, 'https://x.com/i/bookmarks', 'article[data-testid="tweet"]');
  await randomDelay(2000, 3000);
  
  const bookmarks = [];
  const seen = new Set();
  let scrolls = 0;
  const maxScrolls = Math.ceil(limit / 5);
  
  while (bookmarks.length < limit && scrolls < maxScrolls) {
    const tweets = await page.$$eval('article[data-testid="tweet"]', (articles) =>
      articles.map((article) => {
        const text = article.querySelector('[data-testid="tweetText"]')?.innerText || '';
        const author = article.querySelector('[data-testid="User-Name"] a')?.getAttribute('href')?.replace('/', '') || '';
        const time = article.querySelector('time')?.getAttribute('datetime') || '';
        const likes = article.querySelector('[data-testid="like"] span')?.innerText || '0';
        const retweets = article.querySelector('[data-testid="retweet"] span')?.innerText || '0';
        const link = article.querySelector('a[href*="/status/"]')?.getAttribute('href') || '';
        return { author, text, time, likes, retweets, link: link ? `https://x.com${link}` : '', platform: 'twitter' };
      })
    );
    
    for (const tweet of tweets) {
      const key = tweet.link || tweet.text.slice(0, 80);
      if (!seen.has(key) && key) {
        seen.add(key);
        bookmarks.push(tweet);
      }
    }
    
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await sleep(scrollDelay);
    scrolls++;
  }
  
  return bookmarks.slice(0, limit);
}

// ============================================================================
// Notifications Scraper
// ============================================================================

/**
 * Scrape recent notifications (requires login)
 */
export async function scrapeNotifications(page, options = {}) {
  const { limit = 50, tab = 'all', scrollDelay = 2000 } = options;
  
  const url = tab === 'mentions'
    ? 'https://x.com/notifications/mentions'
    : 'https://x.com/notifications';
  
  await page.goto(url, { waitUntil: 'networkidle2' });
  await randomDelay(2000, 3000);
  
  const notifications = [];
  const seen = new Set();
  let scrolls = 0;
  const maxScrolls = Math.ceil(limit / 5);
  
  while (notifications.length < limit && scrolls < maxScrolls) {
    const items = await page.$$eval('article[data-testid="tweet"], [data-testid="notification"]', (els) =>
      els.map((el) => {
        const text = el.innerText || '';
        const time = el.querySelector('time')?.getAttribute('datetime') || '';
        const links = Array.from(el.querySelectorAll('a[href*="/status/"]')).map(a => a.getAttribute('href'));
        return { text: text.slice(0, 280), time, links: links.map(l => `https://x.com${l}`), platform: 'twitter' };
      })
    );
    
    for (const item of items) {
      const key = item.text.slice(0, 100) + item.time;
      if (!seen.has(key) && key.trim()) {
        seen.add(key);
        notifications.push(item);
      }
    }
    
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await sleep(scrollDelay);
    scrolls++;
  }
  
  return notifications.slice(0, limit);
}

// ============================================================================
// Trending Scraper
// ============================================================================

/**
 * Scrape trending topics from the Explore page
 */
export async function scrapeTrending(page, options = {}) {
  const { category = 'trending', limit = 30 } = options;
  const tab = ({
    trending: 'trending',
    news: 'news',
    sports: 'sports',
    entertainment: 'entertainment',
    for_you: 'foryou',
    'for-you': 'foryou',
  })[category] || 'trending';

  await page.goto(`https://x.com/explore/tabs/${tab}`, { waitUntil: 'networkidle2' });
  await randomDelay(2000, 3000);

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await sleep(1500);
  }

  const trends = await page.$$eval('[data-testid="trend"]', (els) =>
    els.map((el) => {
      // A trend cell renders as [rank, "·", category, topic, ...context], e.g.
      // ["4", "·", "Trending in Hong Kong SAR China", "Clara", "Ethan"].
      // Read it by structure: the first span over three characters long is the
      // category label ("Only on X · Trending"), not the topic, and index 0 is
      // the rank — so the old heuristic returned the label as the topic and
      // the rank as the category.
      const texts = Array.from(el.querySelectorAll('span'))
        .map((s) => s.innerText?.trim())
        .filter((t) => t && t !== '·');

      const rank = /^\d+$/.test(texts[0] || '') ? Number(texts[0]) : null;
      const categoryIndex = texts.findIndex((t) => /trending/i.test(t));
      const category = categoryIndex === -1 ? null : texts[categoryIndex];

      // The topic is the span directly after the category label; with no label
      // present, fall back to the first span that is not the rank.
      const topic =
        (categoryIndex === -1
          ? texts.find((t) => t !== texts[0] || rank === null)
          : texts[categoryIndex + 1]) || null;

      // X no longer renders a post count in this view, so this is normally
      // absent. Report null rather than '' so a caller can tell "not shown"
      // from "zero".
      const posts =
        texts.find((t) => /\d[\d.,]*\s*[KMB]?\s+(posts?|tweets?)/i.test(t)) || null;

      return { rank, category, topic, posts, platform: 'twitter' };
    }).filter((item) => item.topic)
  );

  return trends.slice(0, limit);
}

// ============================================================================
// Community Members Scraper
// ============================================================================

/**
 * Scrape members of an X Community
 */
export async function scrapeCommunityMembers(page, communityUrl, options = {}) {
  const { limit = 100, scrollDelay = 2000 } = options;
  
  const membersUrl = communityUrl.endsWith('/members')
    ? communityUrl
    : `${communityUrl}/members`;
  
  await page.goto(membersUrl, { waitUntil: 'networkidle2' });
  await randomDelay(2000, 3000);
  
  const members = [];
  const seen = new Set();
  let scrolls = 0;
  const maxScrolls = Math.ceil(limit / 10);
  
  while (members.length < limit && scrolls < maxScrolls) {
    const users = await page.$$eval('[data-testid="UserCell"]', (cells) =>
      cells.map((cell) => {
        const name = cell.querySelector('[dir="ltr"] span')?.innerText || '';
        const handle = cell.querySelector('a[href^="/"]')?.getAttribute('href')?.replace('/', '') || '';
        const bio = cell.querySelector('[data-testid="userDescription"]')?.innerText || '';
        return { name, handle, bio, platform: 'twitter' };
      })
    );
    
    for (const user of users) {
      if (!seen.has(user.handle) && user.handle) {
        seen.add(user.handle);
        members.push(user);
      }
    }
    
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await sleep(scrollDelay);
    scrolls++;
  }
  
  return members.slice(0, limit);
}

// ============================================================================
// Spaces Scraper
// ============================================================================

/**
 * Scrape X Spaces from search results
 */
export async function scrapeSpaces(page, query, options = {}) {
  const { limit = 20, scrollDelay = 2000 } = options;
  
  await page.goto(`https://x.com/search?q=${encodeURIComponent(query)}&f=top`, {
    waitUntil: 'networkidle2',
  });
  await randomDelay(2000, 3000);
  
  const spaces = [];
  const seen = new Set();
  let scrolls = 0;
  const maxScrolls = Math.ceil(limit / 3);
  
  while (spaces.length < limit && scrolls < maxScrolls) {
    const found = await page.$$eval('a[href*="/i/spaces/"]', (links) =>
      links.map((link) => {
        const href = link.getAttribute('href') || '';
        const card = link.closest('div[data-testid]') || link.parentElement;
        const title = card?.querySelector('span')?.innerText || '';
        return {
          title,
          link: href.startsWith('http') ? href : `https://x.com${href}`,
          platform: 'twitter',
        };
      })
    );
    
    for (const space of found) {
      if (!seen.has(space.link) && space.link) {
        seen.add(space.link);
        spaces.push(space);
      }
    }
    
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await sleep(scrollDelay);
    scrolls++;
  }
  
  return spaces.slice(0, limit);
}

// ============================================================================
// Export Utilities
// ============================================================================

/**
 * Export data to JSON file
 */
export async function exportToJSON(data, filename) {
  await fs.writeFile(filename, JSON.stringify(data, null, 2));
  return filename;
}

/**
 * Export data to CSV file
 */
export async function exportToCSV(data, filename) {
  if (!data.length) return filename;
  
  const headers = Object.keys(data[0]);
  const csvRows = [
    headers.join(','),
    ...data.map(row => 
      headers.map(h => {
        const val = row[h];
        if (typeof val === 'string') {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val ?? '';
      }).join(',')
    ),
  ];
  
  await fs.writeFile(filename, csvRows.join('\n'));
  return filename;
}

// ============================================================================
// Default Export
// ============================================================================

export default {
  createBrowser,
  createPage,
  loginWithCookie,
  scrapeProfile,
  scrapeFollowers,
  scrapeFollowing,
  scrapeTweets,
  searchTweets,
  scrapeThread,
  scrapePost,
  scrapeLikedTweets,
  discoverLikes,
  discoverTimeline,
  discoverBookmarks,
  listBookmarkFolders,
  scrapeLikes,
  scrapeHashtag,
  scrapeMedia,
  scrapeListMembers,
  scrapeBookmarks,
  scrapeNotifications,
  scrapeTrending,
  scrapeCommunityMembers,
  scrapeSpaces,
  exportToJSON,
  exportToCSV,
};
