/* global self, ScraperUtils, ScraperConstants, __scraperDefine */
__scraperDefine('Watchdog', () => {
  const SCOPE = 'watchdog';
  const STALL_MS = 60000;
  const CHECK_INTERVAL_MS = 5000;

  let timer = null;
  let lastProgressAt = 0;
  let onStallCallback = null;
  let scraperType = null;

  function touch() {
    lastProgressAt = Date.now();
  }

  async function notifyStall() {
    ScraperUtils.warn(SCOPE, 'Scrape appears stuck — no progress for', STALL_MS / 1000, 'seconds');
    await chrome.runtime.sendMessage({
      type: ScraperConstants.MSG.SCRAPING_STALL,
      scraperType,
      stalledSince: lastProgressAt
    }).catch(() => {});

    if (typeof onStallCallback === 'function') {
      try {
        await onStallCallback();
      } catch (err) {
        ScraperUtils.error(SCOPE, 'Stall recovery failed:', err);
      }
    }
  }

  function start(type, stallHandler) {
    stop();
    scraperType = type;
    onStallCallback = stallHandler;
    lastProgressAt = Date.now();

    timer = setInterval(async () => {
      const state = await ScraperUtils.getScraperState();
      if (state.status !== ScraperConstants.STATUS_RUNNING) return;

      if (Date.now() - lastProgressAt >= STALL_MS) {
        await notifyStall();
        touch();
      }
    }, CHECK_INTERVAL_MS);

    ScraperUtils.log(SCOPE, 'Started for', type);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    onStallCallback = null;
  }

  return { start, stop, touch };
});
