importScripts('shared/module-loader.js', 'shared/constants.js', 'shared/record-store.js');

const ScraperConstants = globalThis.ScraperConstants;
const RecordStore = globalThis.RecordStore;
const { MSG, STATE_STORAGE_KEY, MAPS_QUEUE_STORAGE_KEY, STATUS_IDLE, STATUS_COMPLETE, STATUS_STOPPED } = ScraperConstants;

RecordStore.migrateFromChromeStorage().catch((err) => {
  console.warn('[background] IDB migration:', err);
});

function nowTs() {
  return Date.now();
}

async function getState() {
  const result = await chrome.storage.local.get([STATE_STORAGE_KEY]);
  return result[STATE_STORAGE_KEY] || { status: STATUS_IDLE, progress: null };
}

async function setState(state) {
  await chrome.storage.local.set({ [STATE_STORAGE_KEY]: state });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (!message || typeof message.type !== 'string') return;

      switch (message.type) {
        case MSG.RECORD_COLLECTED: {
          const { scraperType, record } = message;
          const result = await RecordStore.addRecord(scraperType, record);
          if (!result.duplicate && result.count != null) {
            const state = await getState();
            await setState({ ...state, lastRecordAt: nowTs() });
          }
          sendResponse?.({ ok: true, ...result });
          return;
        }

        case MSG.PROGRESS_UPDATE: {
          const state = await getState();
          await setState({
            ...state,
            status: state.status === STATUS_STOPPED ? STATUS_STOPPED : 'running',
            scraperType: message.scraperType,
            progress: message.progress,
            updatedAt: nowTs()
          });
          sendResponse?.({ ok: true });
          return;
        }

        case MSG.SCRAPING_COMPLETE: {
          await setState({
            status: STATUS_COMPLETE,
            scraperType: message.scraperType,
            progress: message.progress,
            completedAt: nowTs()
          });
          sendResponse?.({ ok: true });
          return;
        }

        case MSG.SCRAPING_ERROR: {
          const state = await getState();
          await setState({
            ...state,
            status: 'error',
            scraperType: message.scraperType,
            error: message.error,
            updatedAt: nowTs()
          });
          sendResponse?.({ ok: true });
          return;
        }

        case MSG.SCRAPING_STALL: {
          const state = await getState();
          await setState({
            ...state,
            status: 'running',
            stalled: true,
            stalledAt: nowTs(),
            stallMessage: 'Scrape appeared stuck — recovery attempted. Check the tab console.'
          });
          sendResponse?.({ ok: true });
          return;
        }

        case MSG.GET_STATE: {
          sendResponse?.({ ok: true, state: await getState() });
          return;
        }

        case MSG.GET_RECORDS: {
          const records = await RecordStore.getAllRecords(message.scraperType);
          sendResponse?.({ ok: true, records });
          return;
        }

        case MSG.GET_RECORD_COUNT: {
          const count = await RecordStore.countRecords(message.scraperType);
          sendResponse?.({ ok: true, count });
          return;
        }

        case MSG.CLEAR_RECORDS: {
          await RecordStore.clearRecords();
          await setState({ status: STATUS_IDLE, progress: null });
          await chrome.storage.local.remove([MAPS_QUEUE_STORAGE_KEY]);
          sendResponse?.({ ok: true });
          return;
        }

        case MSG.PING: {
          sendResponse?.({ ok: true });
          return;
        }

        case 'LEAD_URL_COLLECTED': {
          const result = await RecordStore.addRecord(ScraperConstants.SCRAPER_LINKEDIN, {
            name: message.name,
            url: message.url
          });
          sendResponse?.({ ok: true, ...result });
          return;
        }

        case 'GET_LEADS': {
          sendResponse?.({ ok: true, leads: await RecordStore.getAllRecords() });
          return;
        }

        case 'CLEAR_LEADS': {
          await RecordStore.clearRecords();
          sendResponse?.({ ok: true });
          return;
        }
      }
    } catch (err) {
      console.error('[background] error:', err);
      sendResponse?.({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true;
});
