/* global self, __scraperDefine */
(function initConstants() {
  const root = typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : window;

  if (!root.__scraperDefine) {
    root.__scraperDefine = function (name, factory) {
      if (root[name]) return root[name];
      root[name] = factory();
      return root[name];
    };
  }

  root.__scraperDefine('ScraperConstants', () => ({
    RECORDS_STORAGE_KEY: 'records',
    SETTINGS_STORAGE_KEY: 'settings',
    STATE_STORAGE_KEY: 'scraperState',
    MAPS_QUEUE_STORAGE_KEY: 'mapsScrapeQueue',

    SCRAPER_LINKEDIN: 'linkedin',
    SCRAPER_MAPS: 'google-maps',

    STATUS_IDLE: 'idle',
    STATUS_RUNNING: 'running',
    STATUS_PAUSED: 'paused',
    STATUS_STOPPED: 'stopped',
    STATUS_COMPLETE: 'complete',

    MSG: {
      PING: 'PING',
      CONTENT_SCRIPT_PING: 'CONTENT_SCRIPT_PING',
      START_SCRAPING: 'START_SCRAPING',
      PAUSE_SCRAPING: 'PAUSE_SCRAPING',
      RESUME_SCRAPING: 'RESUME_SCRAPING',
      STOP_SCRAPING: 'STOP_SCRAPING',
      RECORD_COLLECTED: 'RECORD_COLLECTED',
      PROGRESS_UPDATE: 'PROGRESS_UPDATE',
      SCRAPING_COMPLETE: 'SCRAPING_COMPLETE',
      SCRAPING_ERROR: 'SCRAPING_ERROR',
      GET_STATE: 'GET_STATE',
      GET_RECORDS: 'GET_RECORDS',
      CLEAR_RECORDS: 'CLEAR_RECORDS',
      MAPS_QUEUE_READY: 'MAPS_QUEUE_READY',
      MAPS_CONTINUE: 'MAPS_CONTINUE',
      PREFLIGHT_CHECK: 'PREFLIGHT_CHECK',
      SCRAPING_STALL: 'SCRAPING_STALL',
      HEARTBEAT: 'HEARTBEAT',
      GET_RECORD_COUNT: 'GET_RECORD_COUNT'
    },

    MAX_RETRIES: 3,
    WATCHDOG_STALL_MS: 60000,
    JITTER_RATIO: 0.3,

    MAPS_DEFAULT_MAX_RESULTS: 20,
    MAPS_MAX_CANDIDATES: 80,
    LINKEDIN_DEFAULT_MAX_RESULTS: 25
  }));
})();
