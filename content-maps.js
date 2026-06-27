if (globalThis.__mapsContentLoaded) {
  // Entry already registered — skip re-init
} else {
  globalThis.__mapsContentLoaded = true;

  const SCOPE = 'content-maps';

  if (typeof NetworkIntercept !== 'undefined') NetworkIntercept.install();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message?.type) return;

    if (message.type === ScraperConstants.MSG.CONTENT_SCRIPT_PING) {
      sendResponse({ ok: true, scraper: ScraperConstants.SCRAPER_MAPS });
      return;
    }

    const handlers = {
      [ScraperConstants.MSG.START_SCRAPING]: handleStart,
      [ScraperConstants.MSG.PAUSE_SCRAPING]: handlePause,
      [ScraperConstants.MSG.RESUME_SCRAPING]: handleResume,
      [ScraperConstants.MSG.STOP_SCRAPING]: handleStop,
      [ScraperConstants.MSG.PREFLIGHT_CHECK]: handlePreflight
    };

    const handler = handlers[message.type];
    if (!handler) return;

    handler(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => {
        ScraperUtils.error(SCOPE, err);
        sendResponse({ ok: false, error: err.message || String(err) });
      });

    return true;
  });

  async function handlePreflight() {
    return PreflightCheck.run(ScraperConstants.SCRAPER_MAPS);
  }

  async function handleStart() {
    await ScraperUtils.waitForDomReady();
    await ScraperUtils.setScraperState({
      status: ScraperConstants.STATUS_RUNNING,
      scraperType: ScraperConstants.SCRAPER_MAPS,
      startedAt: Date.now()
    });

    try {
      await GoogleMapsScraper.run();
      return { started: true };
    } catch (err) {
      Watchdog.stop();
      await chrome.runtime.sendMessage({
        type: ScraperConstants.MSG.SCRAPING_ERROR,
        scraperType: ScraperConstants.SCRAPER_MAPS,
        error: err.message || String(err)
      }).catch(() => {});
      throw err;
    }
  }

  async function handlePause() {
    const state = await ScraperUtils.getScraperState();
    await ScraperUtils.setScraperState({ ...state, status: ScraperConstants.STATUS_PAUSED });
  }

  async function handleResume() {
    const state = await ScraperUtils.getScraperState();
    await ScraperUtils.setScraperState({ ...state, status: ScraperConstants.STATUS_RUNNING });
  }

  async function handleStop() {
    Watchdog.stop();
    RetryQueue.clear();
    await ScraperUtils.setScraperState({
      status: ScraperConstants.STATUS_STOPPED,
      scraperType: ScraperConstants.SCRAPER_MAPS
    });
    await chrome.storage.local.remove([ScraperConstants.MAPS_QUEUE_STORAGE_KEY]);
  }

  (async () => {
    ScraperUtils.log(SCOPE, 'Google Maps content script loaded on', location.href);
    try {
      const resumed = await GoogleMapsScraper.resumeIfNeeded();
      if (!resumed) {
        const state = await ScraperUtils.getScraperState();
        if (state.status !== ScraperConstants.STATUS_RUNNING) {
          await chrome.storage.local.remove([ScraperConstants.MAPS_QUEUE_STORAGE_KEY]);
        }
      }
    } catch (err) {
      ScraperUtils.error(SCOPE, 'Resume check failed:', err);
    }
  })();
}
