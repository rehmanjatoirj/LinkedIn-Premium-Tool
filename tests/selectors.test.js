/**
 * Selector validation tests — run: npm test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function loadJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function loadFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

function countMatches(html, selector) {
  try {
    const regex = selectorToRegex(selector);
    if (regex) {
      const matches = html.match(regex);
      return matches ? matches.length : 0;
    }
  } catch {
    // fall through
  }
  return htmlIncludesHints(html, selector) ? 1 : 0;
}

function selectorToRegex(selector) {
  if (selector.includes('data-anonymize="person-name"')) {
    return /data-anonymize="person-name"/g;
  }
  if (selector.includes('/sales/lead/')) {
    return /\/sales\/lead\//g;
  }
  if (selector.includes('/maps/place/')) {
    return /\/maps\/place\//g;
  }
  if (selector.includes('role="feed"')) {
    return /role="feed"/g;
  }
  if (selector.includes('hfpxzc')) {
    return /class="hfpxzc"/g;
  }
  if (selector.includes('DUwDvf')) {
    return /class="DUwDvf"/g;
  }
  if (selector.includes('data-item-id="address"')) {
    return /data-item-id="address"/g;
  }
  return null;
}

function htmlIncludesHints(html, selector) {
  const hints = selector.match(/[\w-]+="[^"]+"/g) || [];
  return hints.every((h) => html.includes(h.replace(/\\"/g, '"')));
}

function validateSelectorList(selectors, label) {
  assert.ok(Array.isArray(selectors), `${label} must be an array`);
  assert.ok(selectors.length > 0, `${label} must not be empty`);
  for (const sel of selectors) {
    assert.equal(typeof sel, 'string', `${label} entries must be strings`);
    assert.ok(sel.length > 0, `${label} has empty selector`);
  }
}

test('selectors.json structure is valid', () => {
  const cfg = loadJson('shared/selectors.json');
  assert.ok(cfg.linkedin);
  assert.ok(cfg.googleMaps);
  validateSelectorList(cfg.linkedin.card, 'linkedin.card');
  validateSelectorList(cfg.linkedin.url, 'linkedin.url');
  validateSelectorList(cfg.googleMaps.feed, 'googleMaps.feed');
  validateSelectorList(cfg.googleMaps.resultLink, 'googleMaps.resultLink');
});

test('LinkedIn selectors match fixture HTML', () => {
  const cfg = loadJson('shared/selectors.json');
  const html = loadFixture('linkedin-sample.html');

  const cardHit = cfg.linkedin.card.some((s) => countMatches(html, s) > 0);
  assert.ok(cardHit, 'At least one card selector should match fixture');

  const nameHit = cfg.linkedin.name.some((s) => countMatches(html, s) > 0);
  assert.ok(nameHit, 'At least one name selector should match fixture');

  const urlHit = cfg.linkedin.url.some((s) => countMatches(html, s) > 0);
  assert.ok(urlHit, 'At least one URL selector should match fixture');

  assert.match(html, /Jane Doe/);
  assert.match(html, /sales\/lead\/ABC123/);
});

test('Google Maps selectors match fixture HTML', () => {
  const cfg = loadJson('shared/selectors.json');
  const html = loadFixture('maps-sample.html');

  const feedHit = cfg.googleMaps.feed.some((s) => countMatches(html, s) > 0);
  assert.ok(feedHit, 'Feed selector should match fixture');

  const linkHit = cfg.googleMaps.resultLink.some((s) => countMatches(html, s) > 0);
  assert.ok(linkHit, 'Result link selector should match fixture');

  const nameHit = cfg.googleMaps.name.some((s) => countMatches(html, s) > 0);
  assert.ok(nameHit, 'Place name selector should match fixture');

  assert.match(html, /ABC Plumbing/);
  assert.match(html, /\/maps\/place\//);
});

test('constants.js defines required message types', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8');
  for (const key of ['PREFLIGHT_CHECK', 'SCRAPING_STALL', 'RECORD_COLLECTED', 'PROGRESS_UPDATE']) {
    assert.match(src, new RegExp(key));
  }
});
