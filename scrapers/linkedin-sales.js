/* global ScraperConstants, ScraperUtils, SelectorConfig, NetworkIntercept, RetryQueue, Watchdog, PreflightCheck, __scraperDefine */
__scraperDefine('LinkedInSalesScraper', () => {
  const SCOPE = 'linkedin';

  let sel = {};
  let processedUrls = new Set();
  let progress = { total: 0, processed: 0, success: 0, failed: 0, startTime: 0, elapsedMs: 0 };

  async function loadSelectors() {
    await SelectorConfig.load();
    sel = await SelectorConfig.get('linkedin');
  }

  function queryFirst(root, selectors) {
    for (const selector of selectors || []) {
      try {
        const el = root.querySelector(selector);
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

  function extractUrlFromCard(card) {
    for (const selector of sel.url || []) {
      for (const link of card.querySelectorAll(selector)) {
        const href = link.getAttribute('href') || '';
        if (href.includes('/sales/lead/') || href.includes('/in/')) {
          try {
            return ScraperUtils.normalizeUrl(new URL(href, location.origin).href);
          } catch {
            return ScraperUtils.normalizeUrl(href);
          }
        }
      }
    }
    return '';
  }

  function isLeadCard(card) {
    if (!card) return false;
    if (extractUrlFromCard(card)) return true;
    return Boolean(queryFirst(card, sel.name));
  }

  function findResultCards() {
    for (const selector of sel.card || []) {
      const items = document.querySelectorAll(selector);
      if (!items.length) continue;
      const cards = Array.from(items).filter(isLeadCard);
      if (cards.length) {
        ScraperUtils.log(SCOPE, `Found ${cards.length} cards via ${selector}`);
        return cards;
      }
    }

    const linkCards = [];
    const seen = new Set();
    for (const selector of sel.url || []) {
      document.querySelectorAll(selector).forEach((link) => {
        const container = link.closest('li, [role="listitem"], [data-view-name="search-results-entity"], div[class*="result"]');
        if (container && !seen.has(container)) {
          seen.add(container);
          linkCards.push(container);
        }
      });
    }
    return linkCards;
  }

  function extractLeadFromCard(card) {
    const url = extractUrlFromCard(card);
    let name = queryText(card, sel.name);
    if (!name) {
      const link = queryFirst(card, sel.url);
      if (link) name = ScraperUtils.normalizeText(link.textContent);
    }
    return {
      name,
      title: queryText(card, sel.title),
      company: queryText(card, sel.company),
      url,
      location: queryText(card, sel.location),
      industry: queryText(card, sel.industry),
      source: 'dom'
    };
  }

  function collectAllLeadsFromDom() {
    const leads = [];
    const seen = new Set();
    for (const card of findResultCards()) {
      const lead = extractLeadFromCard(card);
      const key = lead.url || lead.name;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      leads.push(lead);
    }
    return leads;
  }

  function mergeApiLeads(domLeads) {
    const map = new Map();
    for (const lead of domLeads) {
      map.set(lead.url || lead.name, lead);
    }
    for (const apiLead of NetworkIntercept.getLinkedInLeads()) {
      const key = apiLead.url || apiLead.name;
      if (!key) continue;
      const existing = map.get(key);
      map.set(key, existing ? { ...apiLead, ...existing, title: existing.title || apiLead.title } : apiLead);
    }
    return Array.from(map.values());
  }

  async function sendProgress() {
    Watchdog.touch();
    const remaining = Math.max(0, progress.total - progress.processed);
    const avgMs = progress.processed > 0 ? progress.elapsedMs / progress.processed : 650;
    const etaSeconds = Math.round((remaining * avgMs) / 1000);

    await chrome.runtime.sendMessage({
      type: ScraperConstants.MSG.PROGRESS_UPDATE,
      scraperType: ScraperConstants.SCRAPER_LINKEDIN,
      progress: {
        total: progress.total,
        processed: progress.processed,
        remaining,
        success: progress.success,
        failed: progress.failed,
        etaSeconds
      }
    }).catch(() => {});
  }

  async function collectRecord(lead) {
    if (!lead.url && !lead.name) return false;
    if (lead.url && processedUrls.has(lead.url)) return true;

    for (let attempt = 0; attempt < ScraperConstants.MAX_RETRIES; attempt++) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: ScraperConstants.MSG.RECORD_COLLECTED,
          scraperType: ScraperConstants.SCRAPER_LINKEDIN,
          record: lead
        });
        if (lead.url) processedUrls.add(lead.url);
        if (response?.duplicate) return true;
        progress.success++;
        return true;
      } catch (err) {
        ScraperUtils.error(SCOPE, `Save attempt ${attempt + 1} failed:`, err);
        await ScraperUtils.sleepJitter(400 * (attempt + 1));
      }
    }

    progress.failed++;
    RetryQueue.add(lead, 'save failed');
    return false;
  }

  async function scrollAndExtractIncremental(onBatch) {
    const container = queryFirst(document, sel.feedContainer) || document.scrollingElement;
    const stepPx = 280;
    let stableRounds = 0;
    let lastSeenCount = 0;

    for (let i = 0; i < 150; i++) {
      if (!(await ScraperUtils.waitWhilePaused())) return;

      const batch = mergeApiLeads(collectAllLeadsFromDom());
      if (batch.length > lastSeenCount) {
        lastSeenCount = batch.length;
        stableRounds = 0;
        await onBatch(batch);
      } else {
        stableRounds++;
      }

      if (container) {
        container.scrollTop += stepPx;
      }
      window.scrollBy(0, stepPx);

      await ScraperUtils.waitForStableCount(
        () => mergeApiLeads(collectAllLeadsFromDom()).length,
        { stableMs: 600, timeoutMs: 3000, pollMs: 150 }
      );

      if (stableRounds >= 4) break;
    }

    return mergeApiLeads(collectAllLeadsFromDom());
  }

  function findNextPageButton() {
    for (const selector of sel.nextPage || []) {
      try {
        const el = document.querySelector(selector);
        if (el && el.getAttribute('aria-disabled') !== 'true' && !el.disabled) return el;
      } catch {
        // ignore
      }
    }
    for (const btn of document.querySelectorAll('button, a')) {
      const text = ScraperUtils.normalizeText(btn.textContent);
      const label = ScraperUtils.normalizeText(btn.getAttribute('aria-label'));
      if ((/^next$/i.test(text) || /next/i.test(label)) && btn.getAttribute('aria-disabled') !== 'true') {
        return btn;
      }
    }
    return null;
  }

  async function waitForPageChange(prevUrl, prevCount) {
    await ScraperUtils.waitForCondition(() => {
      if (location.href !== prevUrl) return true;
      return findResultCards().length !== prevCount && findResultCards().length > 0;
    }, { timeoutMs: 8000 });
    await ScraperUtils.sleepJitter(800);
  }

  async function processLeads(leads, delayMs) {
    progress.total = Math.max(progress.total, progress.processed + leads.length);
    await sendProgress();

    for (const lead of leads) {
      if (!(await ScraperUtils.waitWhilePaused())) return false;

      const key = lead.url || lead.name;
      if (key && lead.url && processedUrls.has(lead.url)) {
        progress.processed++;
        continue;
      }

      ScraperUtils.log(SCOPE, 'Processing:', lead);
      const ok = await collectRecord(lead);
      if (!ok && !lead.url) {
        RetryQueue.add(lead, 'empty or failed extraction');
      }

      progress.processed++;
      progress.elapsedMs = Date.now() - progress.startTime;
      await sendProgress();

      if (delayMs > 0) await ScraperUtils.sleepJitter(delayMs);
    }
    return true;
  }

  async function stallRecovery() {
    ScraperUtils.warn(SCOPE, 'Attempting stall recovery — re-scroll and re-extract');
    window.scrollTo(0, 0);
    await ScraperUtils.sleep(500);
    const leads = await scrollAndExtractIncremental(async () => {});
    const pending = leads.filter((l) => l.url && !processedUrls.has(l.url));
    if (pending.length) await processLeads(pending, 300);
  }

  async function run() {
    NetworkIntercept.install();
    RetryQueue.clear();
    processedUrls = new Set();
    progress = { total: 0, processed: 0, success: 0, failed: 0, startTime: Date.now(), elapsedMs: 0 };

    await loadSelectors();

    const preflight = await PreflightCheck.run(ScraperConstants.SCRAPER_LINKEDIN);
    if (!preflight.ok) throw new Error(preflight.message);

    Watchdog.start(ScraperConstants.SCRAPER_LINKEDIN, stallRecovery);

    const settings = await ScraperUtils.getSettings();
    const delayMs = Number.isFinite(Number(settings.delayMs)) ? Number(settings.delayMs) : 650;
    const collectAllPages = Boolean(settings.collectAllPages);

    await ScraperUtils.waitForElement(sel.card || sel.url, { timeoutMs: 12000 });
    await ScraperUtils.sleepJitter(500);

    const seenKeys = new Set();
    let pageNum = 1;

    while (true) {
      if (!(await ScraperUtils.waitWhilePaused())) break;

      const allLeads = await scrollAndExtractIncremental(async (batch) => {
        progress.total = Math.max(progress.total, batch.length);
        await sendProgress();
      });

      const newLeads = allLeads.filter((l) => {
        const key = l.url || l.name;
        if (!key || seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });

      ScraperUtils.log(SCOPE, `Page ${pageNum}: ${newLeads.length} new leads (${allLeads.length} total visible)`);
      await processLeads(newLeads, delayMs);

      if (!collectAllPages) break;

      const nextBtn = findNextPageButton();
      if (!nextBtn) break;

      const prevUrl = location.href;
      const prevCount = findResultCards().length;
      nextBtn.click();
      await waitForPageChange(prevUrl, prevCount);
      pageNum++;
      seenKeys.clear();
    }

    const retryResult = await RetryQueue.processAll(collectRecord, { delayMs: 600 });
    ScraperUtils.log(SCOPE, 'Final retry pass:', retryResult);

    Watchdog.stop();

    await chrome.runtime.sendMessage({
      type: ScraperConstants.MSG.SCRAPING_COMPLETE,
      scraperType: ScraperConstants.SCRAPER_LINKEDIN,
      progress
    }).catch(() => {});

    ScraperUtils.log(SCOPE, 'Complete', progress);
  }

  function verifySelectors() {
    const cards = findResultCards();
    const sample = cards.length ? extractLeadFromCard(cards[0]) : NetworkIntercept.getLinkedInLeads()[0];
    return {
      cardsFound: cards.length,
      apiLeads: NetworkIntercept.getLinkedInLeads().length,
      sampleExtracted: sample,
      selectorsOk: Boolean(sample?.url || sample?.name)
    };
  }

  return { run, verifySelectors, findResultCards, extractLeadFromCard };
});
