/* global ScraperConstants, ScraperUtils, SelectorConfig, NetworkIntercept, RetryQueue, Watchdog, PreflightCheck, __scraperDefine */
__scraperDefine('LinkedInSalesScraper', () => {
  const SCOPE = 'linkedin';

  let sel = {};
  let processedKeys = new Set();
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

  function normalizeInUrl(href) {
    if (!href) return '';
    try {
      const parsed = new URL(href, location.origin);
      const slug = parsed.pathname.match(/\/in\/([^/?#]+)/i)?.[1];
      if (!slug) return '';
      return `https://www.linkedin.com/in/${decodeURIComponent(slug)}`;
    } catch {
      const slug = String(href).match(/\/in\/([^/?#]+)/i)?.[1];
      return slug ? `https://www.linkedin.com/in/${decodeURIComponent(slug)}` : '';
    }
  }

  function extractUrlFromCard(card) {
    let inUrl = '';
    let salesUrl = '';

    for (const link of card.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') || '';
      if (href.includes('/in/')) {
        inUrl = inUrl || normalizeInUrl(href);
      } else if (href.includes('/sales/lead/')) {
        try {
          salesUrl = salesUrl || ScraperUtils.normalizeUrl(new URL(href, location.origin).href);
        } catch {
          salesUrl = salesUrl || ScraperUtils.normalizeUrl(href);
        }
      }
    }

    return inUrl || salesUrl;
  }

  function leadKey(lead) {
    const url = lead?.url || '';
    const inSlug = url.match(/\/in\/([^/?#]+)/i)?.[1];
    if (inSlug) return `in:${inSlug.toLowerCase()}`;
    const salesSlug = url.match(/\/sales\/lead\/([^/?#]+)/i)?.[1];
    if (salesSlug) return `sales:${salesSlug.toLowerCase()}`;
    return `name:${(lead?.name || '').toLowerCase()}`;
  }

  function preferPublicUrl(a, b) {
    const aIn = normalizeInUrl(a) || (a?.includes('/in/') ? a : '');
    const bIn = normalizeInUrl(b) || (b?.includes('/in/') ? b : '');
    return aIn || bIn || a || b || '';
  }

  function mergeLeadRecords(base, incoming) {
    if (!base) return incoming;
    if (!incoming) return base;
    return {
      ...base,
      ...incoming,
      name: incoming.name || base.name,
      title: incoming.title || base.title,
      company: incoming.company || base.company,
      location: incoming.location || base.location,
      industry: incoming.industry || base.industry,
      email: incoming.email || base.email || '',
      phone: incoming.phone || base.phone || '',
      url: preferPublicUrl(incoming.url, base.url),
      source: incoming.source || base.source
    };
  }

  function normalizeLeadRecord(lead) {
    const url = preferPublicUrl(lead.url, '');
    return {
      ...lead,
      url: normalizeInUrl(url) || url,
      email: lead.email || '',
      phone: lead.phone || ''
    };
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
    return normalizeLeadRecord({
      name,
      title: queryText(card, sel.title),
      company: queryText(card, sel.company),
      url,
      location: queryText(card, sel.location),
      industry: queryText(card, sel.industry),
      email: '',
      phone: '',
      source: 'dom'
    });
  }

  function collectAllLeadsFromDom() {
    const leads = [];
    const seen = new Set();
    for (const card of findResultCards()) {
      const lead = extractLeadFromCard(card);
      const key = leadKey(lead);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      leads.push(lead);
    }
    return leads;
  }

  function getAllLeadsFromPage() {
    const map = new Map();

    for (const apiLead of NetworkIntercept.getLinkedInLeads()) {
      const lead = normalizeLeadRecord(apiLead);
      const key = leadKey(lead);
      if (!key) continue;
      map.set(key, mergeLeadRecords(map.get(key), lead));
    }

    for (const domLead of collectAllLeadsFromDom()) {
      const key = leadKey(domLead);
      if (!key) continue;
      map.set(key, mergeLeadRecords(map.get(key), domLead));
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
    const record = normalizeLeadRecord(lead);
    if (!record.url && !record.name) return false;

    const key = leadKey(record);
    if (key && processedKeys.has(key)) return true;

    for (let attempt = 0; attempt < ScraperConstants.MAX_RETRIES; attempt++) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: ScraperConstants.MSG.RECORD_COLLECTED,
          scraperType: ScraperConstants.SCRAPER_LINKEDIN,
          record
        });
        if (key) processedKeys.add(key);
        if (response?.duplicate) return true;
        progress.success++;
        return true;
      } catch (err) {
        ScraperUtils.error(SCOPE, `Save attempt ${attempt + 1} failed:`, err);
        await ScraperUtils.sleepJitter(400 * (attempt + 1));
      }
    }

    progress.failed++;
    RetryQueue.add(record, 'save failed');
    return false;
  }

  async function scrollToCollectAll() {
    const container = queryFirst(document, sel.feedContainer);
    let stable = 0;
    let lastCount = 0;

    for (let i = 0; i < 250; i++) {
      if (!(await ScraperUtils.waitWhilePaused())) break;

      const leads = getAllLeadsFromPage();
      if (leads.length > lastCount) {
        lastCount = leads.length;
        stable = 0;
        progress.total = Math.max(progress.total, leads.length);
        await sendProgress();
      } else {
        stable++;
      }

      if (container) {
        container.scrollTop = container.scrollHeight;
      }
      window.scrollTo(0, document.documentElement.scrollHeight);

      await ScraperUtils.sleep(350);

      if (stable >= 8) break;
    }

    return getAllLeadsFromPage();
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
      return getAllLeadsFromPage().length !== prevCount && getAllLeadsFromPage().length > 0;
    }, { timeoutMs: 10000 });
    await ScraperUtils.sleepJitter(1000);
  }

  async function processLeads(leads, delayMs) {
    progress.total = Math.max(progress.total, leads.length);
    await sendProgress();

    for (const lead of leads) {
      if (!(await ScraperUtils.waitWhilePaused())) return false;

      const key = leadKey(lead);
      if (key && processedKeys.has(key)) {
        progress.processed++;
        continue;
      }

      ScraperUtils.log(SCOPE, 'Processing:', lead);
      const ok = await collectRecord(lead);
      if (!ok && !lead.url && !lead.name) {
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
    const leads = await scrollToCollectAll();
    const pending = leads.filter((l) => !processedKeys.has(leadKey(l)));
    if (pending.length) await processLeads(pending, 300);
  }

  async function run() {
    NetworkIntercept.install();
    RetryQueue.clear();
    processedKeys = new Set();
    progress = { total: 0, processed: 0, success: 0, failed: 0, startTime: Date.now(), elapsedMs: 0 };

    await ScraperUtils.waitForDomReady();
    await loadSelectors();

    const preflight = await PreflightCheck.run(ScraperConstants.SCRAPER_LINKEDIN);
    if (!preflight.ok) throw new Error(preflight.message);

    Watchdog.start(ScraperConstants.SCRAPER_LINKEDIN, stallRecovery);

    const settings = await ScraperUtils.getSettings();
    const delayMs = Number.isFinite(Number(settings.delayMs)) ? Number(settings.delayMs) : 650;
    const collectAllPages = Boolean(settings.collectAllPages);

    await ScraperUtils.waitForElement(sel.card || sel.url, { timeoutMs: 12000 });
    await ScraperUtils.sleepJitter(800);

    const seenKeys = new Set();
    let pageNum = 1;

    while (true) {
      if (!(await ScraperUtils.waitWhilePaused())) break;

      const allLeads = await scrollToCollectAll();

      const newLeads = allLeads.filter((l) => {
        const key = leadKey(l);
        if (!key || seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });

      ScraperUtils.log(SCOPE, `Page ${pageNum}: ${newLeads.length} new leads (${allLeads.length} total on page)`);
      await processLeads(newLeads, delayMs);

      if (!collectAllPages) break;

      const nextBtn = findNextPageButton();
      if (!nextBtn) break;

      const prevUrl = location.href;
      const prevCount = getAllLeadsFromPage().length;
      nextBtn.click();
      await waitForPageChange(prevUrl, prevCount);
      pageNum++;
      seenKeys.clear();
      await ScraperUtils.sleepJitter(600);
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
    const sample = cards.length ? extractLeadFromCard(cards[0]) : normalizeLeadRecord(NetworkIntercept.getLinkedInLeads()[0] || {});
    return {
      cardsFound: cards.length,
      apiLeads: NetworkIntercept.getLinkedInLeads().length,
      sampleExtracted: sample,
      selectorsOk: Boolean(sample?.url || sample?.name)
    };
  }

  return { run, verifySelectors, findResultCards, extractLeadFromCard };
});
