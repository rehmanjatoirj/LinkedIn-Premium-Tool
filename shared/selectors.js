/* global self, ScraperConstants, __scraperDefine */
__scraperDefine('SelectorConfig', () => {
  let config = null;
  let loadPromise = null;

  const REMOTE_CONFIG_URL = null; // Set to a URL to enable remote selector updates

  async function loadBundled() {
    const url = chrome.runtime.getURL('shared/selectors.json');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load selectors.json (${res.status})`);
    return res.json();
  }

  async function loadRemote(bundled) {
    if (!REMOTE_CONFIG_URL) return bundled;
    try {
      const res = await fetch(REMOTE_CONFIG_URL, { cache: 'no-cache' });
      if (!res.ok) return bundled;
      const remote = await res.json();
      return deepMerge(bundled, remote);
    } catch {
      return bundled;
    }
  }

  function deepMerge(base, override) {
    const out = { ...base };
    for (const key of Object.keys(override || {})) {
      if (Array.isArray(override[key])) {
        out[key] = override[key];
      } else if (override[key] && typeof override[key] === 'object') {
        out[key] = deepMerge(base[key] || {}, override[key]);
      } else {
        out[key] = override[key];
      }
    }
    return out;
  }

  async function load() {
    if (config) return config;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const bundled = await loadBundled();
      config = await loadRemote(bundled);
      return config;
    })();
    return loadPromise;
  }

  async function get(scraper) {
    const cfg = await load();
    return cfg[scraper] || {};
  }

  function getSync(scraper) {
    if (!config) return {};
    return config[scraper] || {};
  }

  return { load, get, getSync, deepMerge };
});
