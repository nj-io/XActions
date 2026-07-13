// Copyright (c) 2024-2026 nich (@nichxbt). Business Source License 1.1.
/**
 * Pure article-text boundary extraction for x_read_article.
 *
 * The header/footer stripping used to run INSIDE the puppeteer `page.evaluate`
 * (server.js), where it could not be unit-tested — a browser-side closure can't
 * be referenced from a test, and the MCP server calls `main()` on import so it
 * can't be imported from a test either. Extracting it here (pure string in →
 * clean string out) makes the >100-char header heuristic testable and safe to
 * improve later, locked by tests/articleText.test.js.
 *
 * Logic is byte-for-byte identical to the original in-browser stripping so the
 * no-`saveTo` inline response is unchanged.
 *
 * @author nich (@nichxbt)
 */

/**
 * Strip the article header (title / author / @handle / timestamp / engagement)
 * and trailing author footer from a twitterArticleReadView innerText dump.
 *
 * @param {string} rawText      readView.innerText (header + body + footer noise)
 * @param {string} authorName   author display name (footer boundary marker)
 * @param {string} authorHandle author @handle without the leading '@'
 * @returns {string} the verbatim article body, header/footer trimmed
 */
export function extractArticleText(rawText, authorName, authorHandle) {
  const lines = rawText.split('\n');
  let startIdx = 0;
  // Skip past the header — find first line that's actual content (long paragraph)
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    if (lines[i].length > 100) { startIdx = i; break; }
  }
  // Strip footer: author name, @handle, "Following", bio at the end
  let endIdx = lines.length;
  for (let i = lines.length - 1; i > Math.max(0, lines.length - 10); i--) {
    if (lines[i] === authorName || lines[i] === '@' + authorHandle || lines[i] === 'Following') {
      endIdx = Math.min(endIdx, i);
    }
  }
  return lines.slice(startIdx, endIdx).join('\n').trim();
}
