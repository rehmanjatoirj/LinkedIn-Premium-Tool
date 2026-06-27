/* global self, ScraperConstants, __scraperDefine */
__scraperDefine('ScraperUtils', () => {
  const LOG_PREFIX = '[scraper]';

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sleepJitter(baseMs, ratio) {
    const r = ratio ?? ScraperConstants.JITTER_RATIO ?? 0.3;
    const delta = baseMs * r;
    const ms = Math.max(0, baseMs + (Math.random() * 2 - 1) * delta);
    return sleep(ms);
  }

  function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function log(scope, ...args) {
    console.log(`${LOG_PREFIX}[${scope}]`, ...args);
  }

  function warn(scope, ...args) {
    console.warn(`${LOG_PREFIX}[${scope}]`, ...args);
  }

  function error(scope, ...args) {
    console.error(`${LOG_PREFIX}[${scope}]`, ...args);
  }

  function dedupeByKey(items, keyFn) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
      const key = keyFn(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  }

  function getMutationTarget(root) {
    if (root && root !== document) {
      return root.nodeType === Node.ELEMENT_NODE ? root : null;
    }
    return document.body || document.documentElement || null;
  }

  async function waitForDomReady(timeoutMs = 15000) {
    if (document.body) return document.body;

    return new Promise((resolve) => {
      const start = Date.now();

      function done() {
        document.removeEventListener('DOMContentLoaded', onReady);
        clearInterval(timer);
        resolve(document.body || document.documentElement || null);
      }

      function onReady() {
        if (document.body) done();
      }

      const timer = setInterval(() => {
        if (document.body || Date.now() - start >= timeoutMs) done();
      }, 50);

      document.addEventListener('DOMContentLoaded', onReady);
      if (document.readyState !== 'loading') onReady();
    });
  }

  function attachMutationObserver(callback) {
    const tryAttach = () => {
      const target = getMutationTarget(document);
      if (!target) return null;
      const observer = new MutationObserver(callback);
      try {
        observer.observe(target, { childList: true, subtree: true });
        return observer;
      } catch {
        return null;
      }
    };

    let observer = tryAttach();
    if (!observer && document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        if (!observer) observer = tryAttach();
      }, { once: true });
    }
    return {
      disconnect() {
        observer?.disconnect();
      }
    };
  }

  function waitForElement(selectors, options = {}) {
    const {
      root = document,
      timeoutMs = 10000,
      visible = true,
      pollMs = 100
    } = options;

    const selectorList = Array.isArray(selectors) ? selectors : [selectors];

    return new Promise((resolve) => {
      const start = Date.now();
      let settled = false;
      let observerHandle = null;
      let timer = null;

      function cleanup() {
        observerHandle?.disconnect();
        if (timer) clearInterval(timer);
      }

      function finish(el) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(el);
      }

      function matches() {
        for (const selector of selectorList) {
          try {
            const el = root.querySelector(selector);
            if (!el) continue;
            if (visible && el.offsetParent === null && getComputedStyle(el).display === 'none') {
              continue;
            }
            return el;
          } catch {
            // Invalid selector
          }
        }
        return null;
      }

      function tick() {
        const el = matches();
        if (el) {
          finish(el);
          return true;
        }
        if (Date.now() - start >= timeoutMs) {
          finish(null);
          return true;
        }
        return false;
      }

      if (tick()) return;

      observerHandle = attachMutationObserver(() => tick());
      timer = setInterval(() => tick(), pollMs);
    });
  }

  function waitForCondition(checkFn, options = {}) {
    const { timeoutMs = 10000, pollMs = 100 } = options;
    const start = Date.now();
    let settled = false;
    let observerHandle = null;
    let timer = null;

    return new Promise((resolve) => {
      function cleanup() {
        observerHandle?.disconnect();
        if (timer) clearInterval(timer);
      }

      function finish(result) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      }

      function tryCheck() {
        try {
          if (checkFn()) {
            finish(true);
            return true;
          }
        } catch {
          // ignore
        }
        if (Date.now() - start >= timeoutMs) {
          finish(null);
          return true;
        }
        return false;
      }

      if (tryCheck()) return;

      observerHandle = attachMutationObserver(() => tryCheck());
      timer = setInterval(() => tryCheck(), pollMs);
    });
  }

  function waitForStableCount(getCountFn, options = {}) {
    const { stableMs = 800, timeoutMs = 30000, pollMs = 200 } = options;
    const start = Date.now();
    let lastCount = getCountFn();
    let stableSince = Date.now();
    let observerHandle = null;
    let timer = null;

    return new Promise((resolve) => {
      function cleanup() {
        observerHandle?.disconnect();
        if (timer) clearInterval(timer);
      }

      function check() {
        const count = getCountFn();
        if (count !== lastCount) {
          lastCount = count;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= stableMs) {
          cleanup();
          resolve(lastCount);
        } else if (Date.now() - start >= timeoutMs) {
          cleanup();
          resolve(lastCount);
        }
      }

      observerHandle = attachMutationObserver(check);
      timer = setInterval(check, pollMs);
    });
  }

  async function getSettings() {
    const key = ScraperConstants.SETTINGS_STORAGE_KEY;
    const result = await chrome.storage.local.get([key]);
    return result[key] || {};
  }

  async function getScraperState() {
    const key = ScraperConstants.STATE_STORAGE_KEY;
    const result = await chrome.storage.local.get([key]);
    return result[key] || { status: ScraperConstants.STATUS_IDLE };
  }

  async function setScraperState(state) {
    await chrome.storage.local.set({ [ScraperConstants.STATE_STORAGE_KEY]: state });
  }

  async function isPausedOrStopped() {
    const state = await getScraperState();
    return state.status === ScraperConstants.STATUS_PAUSED ||
      state.status === ScraperConstants.STATUS_STOPPED;
  }

  async function waitWhilePaused() {
    while (true) {
      const state = await getScraperState();
      if (state.status === ScraperConstants.STATUS_STOPPED) return false;
      if (state.status !== ScraperConstants.STATUS_PAUSED) return true;
      await sleep(300);
    }
  }

  function extractLatLngFromUrl(url) {
    const match = String(url).match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (match) return { latitude: match[1], longitude: match[2] };
    const dataMatch = String(url).match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (dataMatch) return { latitude: dataMatch[1], longitude: dataMatch[2] };
    return { latitude: '', longitude: '' };
  }

  function normalizeUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url, location.origin);
      parsed.hash = '';
      return parsed.href;
    } catch {
      return String(url).trim();
    }
  }

  return {
    sleep,
    sleepJitter,
    normalizeText,
    log,
    warn,
    error,
    dedupeByKey,
    waitForDomReady,
    waitForElement,
    waitForCondition,
    waitForStableCount,
    getSettings,
    getScraperState,
    setScraperState,
    isPausedOrStopped,
    waitWhilePaused,
    extractLatLngFromUrl,
    normalizeUrl
  };
});
