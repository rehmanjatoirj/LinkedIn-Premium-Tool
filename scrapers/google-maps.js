/* global ScraperConstants, ScraperUtils, SelectorConfig, NetworkIntercept, RetryQueue, Watchdog, PreflightCheck, __scraperDefine */
__scraperDefine('GoogleMapsScraper', () => {
  const SCOPE = 'google-maps';
  const RESUME_KEY = ScraperConstants.MAPS_QUEUE_STORAGE_KEY;

  const RECORD_FIELDS = [
    'name', 'category', 'address', 'phone', 'website', 'hours', 'email'
  ];

  let sel = {};
  let mapsSettings = { mapsMaxResults: 20 };
  let progress = { total: 0, processed: 0, success: 0, failed: 0, skipped: 0, startTime: 0, elapsedMs: 0 };
  const savedUrls = new Set();
  let placeQueue = [];

  async function loadSelectors() {
    await SelectorConfig.load();
    sel = await SelectorConfig.get('googleMaps');
  }

  async function loadMapsSettings() {
    const settings = await ScraperUtils.getSettings();
    mapsSettings = {
      mapsMaxResults: Math.min(
        100,
        Math.max(1, Number(settings.mapsMaxResults) || ScraperConstants.MAPS_DEFAULT_MAX_RESULTS)
      )
    };
  }

  async function saveProgressState(index, extra) {
    await chrome.storage.local.set({
      [RESUME_KEY]: {
        phase: 'click',
        index,
        queue: placeQueue,
        progress,
        mapsMaxResults: mapsSettings.mapsMaxResults,
        searchUrl: extra?.searchUrl || location.href,
        pendingExtract: extra?.pendingExtract || false,
        currentItem: extra?.item || null,
        ...extra
      }
    });
  }

  async function loadProgressState() {
    const result = await chrome.storage.local.get([RESUME_KEY]);
    return result[RESUME_KEY] || null;
  }

  async function clearProgressState() {
    await chrome.storage.local.remove([RESUME_KEY]);
  }

  function queryFirst(root, selectors) {
    for (const selector of selectors || []) {
      try {
        const el = (root || document).querySelector(selector);
        if (el) return el;
      } catch {
        // ignore
      }
    }
    return null;
  }

  function queryText(root, selectors) {
    const el = queryFirst(root, selectors);
    return el ? ScraperUtils.normalizeText(el.textContent) : '';
  }

  function isPlacePage() {
    return location.pathname.includes('/maps/place/');
  }

  function isSearchResultsPage() {
    return location.pathname.includes('/search') ||
      Boolean(queryFirst(document, sel.feed)) ||
      document.querySelectorAll((sel.resultLink || []).join(',')).length > 0;
  }

  function findFeedContainer() {
    return queryFirst(document, sel.feed);
  }

  function normalizePlaceUrl(href) {
    try {
      return ScraperUtils.normalizeUrl(new URL(href, location.origin).href);
    } catch {
      return ScraperUtils.normalizeUrl(href);
    }
  }

  function nameFromUrl(url) {
    const match = String(url || '').match(/\/maps\/place\/([^/@?]+)/);
    if (!match) return '';
    try {
      return ScraperUtils.normalizeText(decodeURIComponent(match[1].replace(/\+/g, ' ')));
    } catch {
      return ScraperUtils.normalizeText(match[1].replace(/\+/g, ' '));
    }
  }

  function collectPlaceUrlsFromDom() {
    const urls = [];
    const seen = new Set();
    for (const selector of sel.resultLink || ['a.hfpxzc', 'a[href*="/maps/place/"]']) {
      document.querySelectorAll(selector).forEach((link) => {
        const href = link.getAttribute('href') || '';
        if (!href.includes('/maps/place')) return;
        const url = normalizePlaceUrl(href);
        if (seen.has(url)) return;
        seen.add(url);
        urls.push(url);
      });
    }
    return urls;
  }

  function findLinkForUrl(url) {
    const slug = url.split('/place/')[1]?.split('/')[0] || '';
    const esc = (value) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value);
    if (slug) {
      const bySlug = document.querySelector(`a[href*="/maps/place/${esc(slug)}"]`);
      if (bySlug) return bySlug;
    }
    for (const link of document.querySelectorAll('a[href*="/maps/place/"]')) {
      if (normalizePlaceUrl(link.getAttribute('href')) === url) return link;
    }
    return null;
  }

  function listPreviewFromLink(link) {
    const aria = link.getAttribute('aria-label') || '';
    let name = ScraperUtils.normalizeText(aria.split('·')[0] || link.textContent);
    let category = '';
    if (aria) {
      const parts = aria.split('·').map((p) => p.trim());
      if (parts.length > 3) category = parts[parts.length - 1];
    }
    return { name, category, url: normalizePlaceUrl(link.getAttribute('href')) };
  }

  function mergeRecordFields(preview, details, url) {
    const merged = { ...(preview || {}), url: url || preview?.url || details?.url || '' };
    for (const key of RECORD_FIELDS) {
      const detailVal = details?.[key];
      const previewVal = preview?.[key];
      merged[key] = String(detailVal ?? '').trim() || String(previewVal ?? '').trim() || '';
    }
    merged.name = merged.name || String(details?.name ?? preview?.name ?? nameFromUrl(url) ?? '').trim();
    return merged;
  }

  function elementDisplayText(el) {
    if (!el) return '';
    const child = el.querySelector('.Io6YTe, .fontBodyMedium, .rogA2c, [class*="Io6YTe"]');
    if (child) return ScraperUtils.normalizeText(child.textContent);
    const aria = el.getAttribute('aria-label') || '';
    if (aria) return ScraperUtils.normalizeText(aria);
    return ScraperUtils.normalizeText(el.textContent);
  }

  function extractByDataItemId(fragment) {
    const candidates = document.querySelectorAll(
      `[data-item-id="${fragment}"], [data-item-id^="${fragment}"], [data-item-id*="${fragment}"]`
    );
    for (const el of candidates) {
      const text = elementDisplayText(el);
      if (text) return text;
      const id = el.getAttribute('data-item-id') || '';
      if (fragment === 'phone' || id.includes('phone')) {
        const tel = id.match(/phone:tel:([^"]+)/i);
        if (tel) {
          try {
            return decodeURIComponent(tel[1].replace(/\+/g, '%2B')).trim();
          } catch {
            return tel[1].trim();
          }
        }
      }
      if (fragment === 'address' || id.startsWith('address')) {
        const addr = id.match(/address:(.+)/i);
        if (addr) {
          try {
            return decodeURIComponent(addr[1].replace(/\+/g, ' ')).trim();
          } catch {
            return addr[1].trim();
          }
        }
      }
    }
    return '';
  }

  function extractPhone() {
    let raw =
      extractByDataItemId('phone:tel:') ||
      extractByDataItemId('phone') ||
      queryText(document, sel.phone);
    for (const btn of document.querySelectorAll('button[aria-label*="Phone" i], a[aria-label*="Phone" i]')) {
      const label = btn.getAttribute('aria-label') || '';
      const m = label.match(/Phone:?\s*(.+)/i);
      if (m) {
        raw = raw || ScraperUtils.normalizeText(m[1]);
        break;
      }
    }
    return raw.replace(/^Phone:?\s*/i, '').replace(/^Call phone number\s*/i, '').trim();
  }

  function extractAddress() {
    let raw =
      extractByDataItemId('address') ||
      queryText(document, sel.address);
    for (const btn of document.querySelectorAll('button[aria-label*="Address" i]')) {
      const label = btn.getAttribute('aria-label') || '';
      const cleaned = label.replace(/^Address:?\s*/i, '').trim();
      if (cleaned) {
        raw = raw || cleaned;
        break;
      }
    }
    return raw.replace(/^Address:?\s*/i, '').trim();
  }

  function extractWebsite() {
    const el = queryFirst(document, sel.website || [
      'a[data-item-id="authority"]',
      'a[aria-label*="Website" i]',
      'a[data-tooltip*="Website" i]'
    ]);
    if (!el) return '';
    const href = el.getAttribute('href') || '';
    if (href.startsWith('http') && !href.includes('google.com/url')) return href;
    const text = elementDisplayText(el);
    if (text.startsWith('http')) return text;
    return text;
  }

  function extractEmail() {
    const mailto = document.querySelector('a[href^="mailto:"]');
    if (mailto) return mailto.getAttribute('href').replace(/^mailto:/i, '').split('?')[0];
    const panel = document.querySelector('[role="main"], .m6QErb');
    const text = panel?.innerText || document.body?.innerText || '';
    const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return match ? match[0] : '';
  }

  function getPlaceName() {
    return (
      queryText(document, sel.name) ||
      queryText(document, ['h1.DUwDvf', 'h1[class*="fontHeadline"]', 'h1']) ||
      nameFromUrl(location.href)
    );
  }

  function mergeApiPlaceData(record) {
    const places = NetworkIntercept.getMapsPlaces();
    if (!places.length) return record;

    const nameKey = (record?.name || nameFromUrl(record?.url)).toLowerCase().slice(0, 12);
    let match = null;

    if (nameKey) {
      match = places.find((p) => {
        if (!p.name) return false;
        const pn = p.name.toLowerCase();
        return pn.includes(nameKey) || nameKey.includes(pn.slice(0, 12));
      });
    }

    if (!match) {
      match = [...places].reverse().find((p) => p.phone || p.address);
    }

    if (!match) return record;
    return mergeRecordFields(record, match, record.url);
  }

  function extractPlaceDetails(fallbackUrl) {
    const url = fallbackUrl || ScraperUtils.normalizeUrl(location.href);

    const categoryEl = queryFirst(document, sel.category);
    let category = categoryEl ? elementDisplayText(categoryEl) : '';
    if (!category && categoryEl) category = ScraperUtils.normalizeText(categoryEl.textContent);

    return {
      name: getPlaceName(),
      category,
      address: extractAddress(),
      phone: extractPhone(),
      website: extractWebsite(),
      hours: (() => {
        const btn = queryFirst(document, sel.hours || ['button[data-item-id="oh"]', 'button[aria-label*="Hours" i]']);
        if (!btn) return '';
        return elementDisplayText(btn).replace(/^Hours:?\s*/i, '');
      })(),
      email: extractEmail(),
      url,
      source: 'side-panel'
    };
  }

  async function scrollSidePanel() {
    const scrollables = [
      findFeedContainer(),
      document.querySelector('[role="main"]'),
      ...document.querySelectorAll('.m6QErb, [role="region"], .section-scrollbox')
    ].filter(Boolean);

    for (const el of scrollables) {
      for (let i = 0; i < 3; i++) {
        el.scrollTop = el.scrollHeight;
        await ScraperUtils.sleep(100);
      }
    }
  }

  async function performClick(link) {
    try {
      link.scrollIntoView({ block: 'center', behavior: 'auto' });
    } catch {
      link.scrollIntoView(true);
    }
    await ScraperUtils.sleep(350);

    const target = link.closest('a.hfpxzc') || link;
    const rect = target.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + Math.max(1, rect.width / 2),
      clientY: rect.top + Math.max(1, rect.height / 2)
    };

    target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    target.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
    target.click();
  }

  function namesMatch(a, b) {
    if (!a || !b) return false;
    const na = a.toLowerCase().replace(/[^a-z0-9]/g, '');
    const nb = b.toLowerCase().replace(/[^a-z0-9]/g, '');
    const slice = Math.min(8, na.length, nb.length);
    return na.slice(0, slice) === nb.slice(0, slice) || na.includes(nb.slice(0, slice)) || nb.includes(na.slice(0, slice));
  }

  async function waitForSidePanel(expectedName, previousName) {
    await ScraperUtils.waitForDomReady();

    await ScraperUtils.waitForCondition(() => {
      const name = getPlaceName();
      if (!name) return false;
      if (expectedName && namesMatch(name, expectedName)) return true;
      if (previousName && !namesMatch(name, previousName)) return true;
      return isPlacePage() && name.length > 1;
    }, { timeoutMs: 12000, pollMs: 200 });

    await ScraperUtils.waitForCondition(() => {
      return Boolean(
        document.querySelector('[data-item-id*="phone"], [data-item-id="address"], [data-item-id="authority"]') ||
        document.querySelector('button[aria-label*="Phone" i], button[aria-label*="Address" i]') ||
        getPlaceName().length > 1
      );
    }, { timeoutMs: 10000, pollMs: 200 });

    await scrollSidePanel();
    await ScraperUtils.sleep(900);
  }

  async function waitForPlacePageReady() {
    await ScraperUtils.waitForDomReady();
    await ScraperUtils.waitForElement(
      (sel.name || []).concat(['h1.DUwDvf', 'h1[class*="fontHeadline"]', 'h1']),
      { timeoutMs: 20000 }
    );
    await ScraperUtils.waitForCondition(() => {
      return Boolean(
        extractPhone() ||
        extractAddress() ||
        getPlaceName().length > 1
      );
    }, { timeoutMs: 12000, pollMs: 200 });
    await scrollSidePanel();
    await ScraperUtils.sleep(800);
  }

  async function sendProgress() {
    Watchdog.touch();
    const remaining = Math.max(0, mapsSettings.mapsMaxResults - progress.success);
    const avgMs = progress.processed > 0 ? progress.elapsedMs / progress.processed : 2000;
    await chrome.runtime.sendMessage({
      type: ScraperConstants.MSG.PROGRESS_UPDATE,
      scraperType: ScraperConstants.SCRAPER_MAPS,
      progress: {
        total: mapsSettings.mapsMaxResults,
        processed: progress.processed,
        remaining,
        success: progress.success,
        failed: progress.failed,
        skipped: progress.skipped,
        etaSeconds: Math.round((remaining * avgMs) / 1000)
      }
    }).catch(() => {});
  }

  async function saveRecord(record) {
    if (!record?.name?.trim()) return false;

    for (let attempt = 0; attempt < ScraperConstants.MAX_RETRIES; attempt++) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: ScraperConstants.MSG.RECORD_COLLECTED,
          scraperType: ScraperConstants.SCRAPER_MAPS,
          record
        });
        if (response?.duplicate) {
          progress.skipped++;
          return false;
        }
        progress.success++;
        if (record.url) savedUrls.add(record.url);
        return true;
      } catch (err) {
        ScraperUtils.error(SCOPE, `Save attempt ${attempt + 1}:`, err);
        await ScraperUtils.sleepJitter(400 * (attempt + 1));
      }
    }
    progress.failed++;
    RetryQueue.add(record, 'save failed');
    return false;
  }

  async function scrollToLoadUrls(minCount) {
    const feed = findFeedContainer();
    let stable = 0;
    let last = 0;

    for (let i = 0; i < 60; i++) {
      const urls = collectPlaceUrlsFromDom();
      if (urls.length >= minCount) return urls.slice(0, minCount);

      if (feed) feed.scrollTop = feed.scrollHeight;
      else window.scrollTo(0, document.body.scrollHeight);

      await ScraperUtils.sleep(400);

      if (urls.length === last) {
        stable++;
        if (stable >= 3) break;
      } else {
        stable = 0;
        last = urls.length;
      }
    }

    return collectPlaceUrlsFromDom().slice(0, minCount);
  }

  function buildQueue(urls) {
    return urls.map((url) => {
      const link = findLinkForUrl(url);
      const preview = link
        ? listPreviewFromLink(link)
        : { name: nameFromUrl(url), category: '', url };
      if (!preview.name) preview.name = nameFromUrl(url);
      return { url, preview };
    }).filter((item) => item.url);
  }

  async function clickAndExtract(item, index, searchUrl) {
    let link = findLinkForUrl(item.url);
    if (!link) {
      const feed = findFeedContainer();
      for (let i = 0; i < 20 && !link; i++) {
        if (feed) feed.scrollTop += 350;
        await ScraperUtils.sleep(350);
        link = findLinkForUrl(item.url);
      }
    }
    if (!link) throw new Error('Business not visible in results list');

    const previousName = getPlaceName();
    ScraperUtils.log(SCOPE, 'Clicking result:', item.preview.name || item.url);

    await saveProgressState(index, {
      pendingExtract: true,
      item,
      searchUrl: searchUrl || location.href
    });

    await performClick(link);
    await ScraperUtils.sleep(600);

    if (isPlacePage() && !isSearchResultsPage()) {
      ScraperUtils.log(SCOPE, 'Navigated to place page — will extract after reload');
      return { navigationPending: true };
    }

    await waitForSidePanel(item.preview.name || nameFromUrl(item.url), previousName);

    let details = extractPlaceDetails(item.url);
    let record = mergeRecordFields(item.preview, details, item.url);
    record = mergeApiPlaceData(record);

    if (!record.phone && !record.address) {
      ScraperUtils.warn(SCOPE, 'Panel missing contact info, waiting longer…');
      await ScraperUtils.sleep(1500);
      await scrollSidePanel();
      details = extractPlaceDetails(item.url);
      record = mergeApiPlaceData(mergeRecordFields(item.preview, details, item.url));
    }

    await saveProgressState(index, { pendingExtract: false, searchUrl: searchUrl || location.href });

    ScraperUtils.log(SCOPE, 'Extracted:', record);
    return record;
  }

  async function extractOnPlacePageAndContinue(saved) {
    await loadSelectors();
    mapsSettings.mapsMaxResults = saved.mapsMaxResults || mapsSettings.mapsMaxResults;
    if (saved.progress) progress = { ...progress, ...saved.progress };
    if (saved.queue?.length) placeQueue = saved.queue;

    Watchdog.start(ScraperConstants.SCRAPER_MAPS, stallRecovery);

    const index = saved.index ?? 0;
    const item = saved.currentItem || saved.queue?.[index];
    if (!item) {
      await clearProgressState();
      return;
    }

    if (!(await ScraperUtils.waitWhilePaused())) {
      await clearProgressState();
      return;
    }

    progress.processed = (progress.processed || 0) + 1;
    progress.elapsedMs = Date.now() - (progress.startTime || Date.now());

    try {
      await waitForPlacePageReady();
      const details = extractPlaceDetails(item.url || location.href);
      let record = mergeRecordFields(item.preview, details, item.url || location.href);
      record = mergeApiPlaceData(record);

      if (!record.phone && !record.address) {
        await ScraperUtils.sleep(1200);
        const retry = extractPlaceDetails(item.url || location.href);
        record = mergeApiPlaceData(mergeRecordFields(item.preview, retry, item.url || location.href));
      }

      ScraperUtils.log(SCOPE, 'Extracted on place page:', record);

      if (record.name) {
        await saveRecord(record);
      } else if (item.preview?.name) {
        await saveRecord(mergeRecordFields(item.preview, {}, item.url || location.href));
      } else {
        progress.failed++;
      }
    } catch (err) {
      progress.failed++;
      ScraperUtils.error(SCOPE, 'Place page extract failed:', err);
      if (item.preview?.name) {
        await saveRecord(mergeRecordFields(item.preview, {}, item.url || location.href));
      }
    }

    await sendProgress();

    const nextIndex = index + 1;
    if (progress.success >= mapsSettings.mapsMaxResults || nextIndex >= placeQueue.length) {
      await finishScraping();
      return;
    }

    if (!(await ScraperUtils.waitWhilePaused())) {
      await clearProgressState();
      return;
    }

    await saveProgressState(nextIndex, {
      pendingExtract: false,
      searchUrl: saved.searchUrl || ''
    });

    const returnUrl = saved.searchUrl;
    if (returnUrl && returnUrl !== location.href) {
      ScraperUtils.log(SCOPE, 'Returning to search results for next business');
      location.assign(returnUrl);
      return;
    }

    await processQueue(nextIndex);
    await finishScraping();
  }

  async function processQueue(startIndex, searchUrl) {
    const baseSearchUrl = searchUrl || location.href;

    for (let i = startIndex; i < placeQueue.length; i++) {
      if (progress.success >= mapsSettings.mapsMaxResults) break;
      if (!(await ScraperUtils.waitWhilePaused())) return;

      const item = placeQueue[i];
      if (savedUrls.has(item.url)) {
        progress.skipped++;
        await sendProgress();
        continue;
      }

      progress.elapsedMs = Date.now() - progress.startTime;
      await saveProgressState(i, { searchUrl: baseSearchUrl });

      let record = null;
      for (let attempt = 0; attempt < ScraperConstants.MAX_RETRIES; attempt++) {
        try {
          record = await clickAndExtract(item, i, baseSearchUrl);
          if (record?.navigationPending) return;
          if (record?.name) break;
          throw new Error('Empty record');
        } catch (err) {
          ScraperUtils.error(SCOPE, `Extract attempt ${attempt + 1}:`, err);
          if (attempt < ScraperConstants.MAX_RETRIES - 1) {
            await ScraperUtils.sleepJitter(700 * (attempt + 1));
          }
        }
      }

      progress.processed++;

      if (record?.name) {
        await saveRecord(record);
      } else if (item.preview?.name) {
        await saveRecord(mergeRecordFields(item.preview, {}, item.url));
        progress.failed++;
      } else {
        progress.failed++;
      }

      await sendProgress();
      await ScraperUtils.sleepJitter(450);
    }
  }

  async function finishScraping() {
    await RetryQueue.processAll(saveRecord, { delayMs: 500 });
    Watchdog.stop();
    await clearProgressState();
    await chrome.runtime.sendMessage({
      type: ScraperConstants.MSG.SCRAPING_COMPLETE,
      scraperType: ScraperConstants.SCRAPER_MAPS,
      progress
    }).catch(() => {});
    ScraperUtils.log(SCOPE, 'Complete — saved:', progress.success);
  }

  async function stallRecovery() {
    ScraperUtils.warn(SCOPE, 'Stall recovery — re-extract side panel');
    const details = extractPlaceDetails(location.href);
    if (details.name) await saveRecord(mergeApiPlaceData(details));
  }

  async function runSearchPageScrape(resumeIndex, searchUrl) {
    progress = {
      total: mapsSettings.mapsMaxResults,
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      startTime: Date.now(),
      elapsedMs: 0
    };
    savedUrls.clear();
    RetryQueue.clear();

    await ScraperUtils.waitForDomReady();
    await ScraperUtils.waitForElement(
      (sel.feed || []).concat(sel.resultLink || []),
      { timeoutMs: 15000 }
    );
    await ScraperUtils.sleep(500);

    const urls = await scrollToLoadUrls(mapsSettings.mapsMaxResults);
    placeQueue = buildQueue(urls);
    if (!placeQueue.length) throw new Error('No businesses found. Run a Google Maps search first.');

    const baseSearchUrl = searchUrl || location.href;
    ScraperUtils.log(SCOPE, `Queue: ${placeQueue.length} — clicking each result`);
    await processQueue(resumeIndex || 0, baseSearchUrl);
    await finishScraping();
  }

  async function run() {
    NetworkIntercept.install();
    await ScraperUtils.waitForDomReady();
    await loadSelectors();
    await loadMapsSettings();

    const saved = await loadProgressState();

    if (saved?.phase === 'place') {
      await clearProgressState();
    }

    if (saved?.pendingExtract && isPlacePage()) {
      await extractOnPlacePageAndContinue(saved);
      return;
    }

    const resumeIndex = saved?.phase === 'click' ? saved.index : 0;
    if (saved?.progress) progress = { ...progress, ...saved.progress };
    if (saved?.queue?.length) placeQueue = saved.queue;

    const preflight = await PreflightCheck.run(ScraperConstants.SCRAPER_MAPS);
    if (!preflight.ok) throw new Error(preflight.message);

    if (!isSearchResultsPage() && !isPlacePage()) {
      throw new Error('Open Google Maps search results (e.g. "plumbers near me"), then start scraping.');
    }

    Watchdog.start(ScraperConstants.SCRAPER_MAPS, stallRecovery);

    if (isSearchResultsPage()) {
      if (saved?.phase === 'click' && placeQueue.length && resumeIndex > 0) {
        ScraperUtils.log(SCOPE, 'Resuming click queue at index', resumeIndex);
        await processQueue(resumeIndex, saved.searchUrl || location.href);
        await finishScraping();
        return;
      }
      await runSearchPageScrape(0);
      return;
    }

    if (isPlacePage() && saved?.pendingExtract) {
      await extractOnPlacePageAndContinue(saved);
    }
  }

  async function resumeIfNeeded() {
    await ScraperUtils.waitForDomReady();

    const state = await ScraperUtils.getScraperState();
    if (state.status !== ScraperConstants.STATUS_RUNNING) return false;

    const saved = await loadProgressState();
    if (!saved) return false;

    if (saved.phase === 'place') {
      await clearProgressState();
      return false;
    }

    if (saved.pendingExtract && isPlacePage()) {
      ScraperUtils.log(SCOPE, 'Auto-resuming after place page navigation');
      await run();
      return true;
    }

    if (saved.phase === 'click' && isSearchResultsPage() && saved.index > 0) {
      ScraperUtils.log(SCOPE, 'Auto-resuming search page queue');
      await run();
      return true;
    }

    return false;
  }

  return { run, resumeIfNeeded, extractPlaceDetails, mergeRecordFields };
});
