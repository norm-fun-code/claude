// fetchRandomNotionPage used to return a fabricated { text: 'No pages found.',
// pageTitle: 'Notion' } "success" when the configured parent page has zero
// child pages — that literal sentence then flowed straight into the wisdom-
// insight LLM prompt as if it were real page content, risking a fabricated
// "insight" about the placeholder string itself. It should return the same
// empty shape briefing.js's unwrap() already falls back to on a genuine
// fetch failure, so "no pages" and "fetch failed" are indistinguishable to
// downstream consumers (both mean: nothing to quote).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@notionhq/client');

process.env.NOTION_API_KEY = 'test-key';
process.env.NOTION_PAGE_ID = 'test-page-id';

const { fetchRandomNotionPage } = require('../src/services/notion');

test('fetchRandomNotionPage returns empty text (not a fabricated sentence) when there are no child pages', async () => {
  Client.prototype.request = async () => ({ results: [], has_more: false });
  const result = await fetchRandomNotionPage();
  assert.deepEqual(result, { text: '', pageTitle: 'Notion' });
});

test('fetchRandomNotionPage returns real content when a child page exists', async () => {
  Client.prototype.request = async ({ path }) => {
    if (path === `blocks/${process.env.NOTION_PAGE_ID}/children`) {
      return {
        results: [{ type: 'child_page', id: 'child-1', child_page: { title: 'My Page' } }],
        has_more: false,
      };
    }
    if (path === 'blocks/child-1/children') {
      return {
        results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Some wisdom.' }] } }],
        has_more: false,
      };
    }
    return { results: [], has_more: false };
  };
  const result = await fetchRandomNotionPage();
  assert.equal(result.pageTitle, 'My Page');
  assert.equal(result.text, 'Some wisdom.');
});
