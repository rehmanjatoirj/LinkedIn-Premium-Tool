/* global self, ScraperConstants, __scraperDefine */
(function initRecordStore() {
  const root = typeof globalThis !== 'undefined' ? globalThis : self;

  if (!root.__scraperDefine) {
    root.__scraperDefine = function (name, factory) {
      if (root[name]) return root[name];
      root[name] = factory();
      return root[name];
    };
  }

  root.__scraperDefine('RecordStore', () => {
  const DB_NAME = 'ScraperRecordsDB';
  const DB_VERSION = 1;
  const STORE = 'records';
  const INDEX_SCRAPER = 'scraperType';
  const INDEX_KEY = 'recordKey';

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex(INDEX_SCRAPER, INDEX_SCRAPER, { unique: false });
          store.createIndex(INDEX_KEY, INDEX_KEY, { unique: true });
        }
      };
    });
    return dbPromise;
  }

  function makeRecordKey(record, scraperType) {
    if (scraperType === 'google-maps') {
      return (record.url || `${record.name}|${record.address || ''}`).trim();
    }
    return (record.url || record.name || '').trim();
  }

  async function addRecord(scraperType, record) {
    const db = await openDb();
    const recordKey = makeRecordKey(record, scraperType);
    const entry = {
      ...record,
      scraperType,
      recordKey,
      timestamp: record.timestamp || Date.now()
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.index(INDEX_KEY).get(recordKey);
      getReq.onsuccess = () => {
        if (getReq.result) {
          resolve({ duplicate: true, count: null });
          return;
        }
        const addReq = store.add(entry);
        addReq.onsuccess = async () => {
          const count = await countRecords(scraperType);
          resolve({ duplicate: false, count });
        };
        addReq.onerror = () => {
          if (addReq.error?.name === 'ConstraintError') {
            resolve({ duplicate: true, count: null });
          } else {
            reject(addReq.error);
          }
        };
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function countRecords(scraperType) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      if (scraperType) {
        const idx = store.index(INDEX_SCRAPER);
        const req = idx.count(scraperType);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } else {
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }
    });
  }

  async function getAllRecords(scraperType) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const results = [];

      if (scraperType) {
        const idx = store.index(INDEX_SCRAPER);
        const req = idx.openCursor(IDBKeyRange.only(scraperType));
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const { id, recordKey, ...rest } = cursor.value;
            results.push(rest);
            cursor.continue();
          } else {
            resolve(results);
          }
        };
        req.onerror = () => reject(req.error);
      } else {
        const req = store.getAll();
        req.onsuccess = () => {
          resolve((req.result || []).map(({ id, recordKey, ...rest }) => rest));
        };
        req.onerror = () => reject(req.error);
      }
    });
  }

  async function clearRecords() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function migrateFromChromeStorage() {
    try {
      const result = await chrome.storage.local.get(['records', 'leads']);
      const legacy = result.records?.length ? result.records : result.leads;
      if (!legacy?.length) return 0;

      let migrated = 0;
      for (const item of legacy) {
        const type = item.scraperType || 'linkedin';
        const res = await addRecord(type, item);
        if (!res.duplicate) migrated++;
      }
      await chrome.storage.local.remove(['records', 'leads']);
      return migrated;
    } catch (err) {
      console.warn('[RecordStore] migration failed:', err);
      return 0;
    }
  }

  return {
    addRecord,
    getAllRecords,
    countRecords,
    clearRecords,
    migrateFromChromeStorage,
    makeRecordKey
  };
  });
})();
