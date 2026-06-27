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

  function normalizeInUrl(href) {
    if (!href || href.includes('/sales/')) return '';
    try {
      const parsed = new URL(href, 'https://www.linkedin.com');
      const slug = parsed.pathname.match(/\/in\/([^/?#]+)/i)?.[1];
      if (!slug) return '';
      return `https://www.linkedin.com/in/${decodeURIComponent(slug)}`;
    } catch {
      const slug = String(href).match(/\/in\/([^/?#]+)/i)?.[1];
      return slug ? `https://www.linkedin.com/in/${decodeURIComponent(slug)}` : '';
    }
  }

  function extractSalesLeadId(cardOrUrl) {
    const href = typeof cardOrUrl === 'string'
      ? cardOrUrl
      : cardOrUrl?.querySelector?.('a[href*="/sales/lead/"]')?.getAttribute('href') || '';
    return href.match(/\/sales\/lead\/([^,/?#]+)/i)?.[1] || '';
  }

  function namesMatch(a, b) {
    if (!a || !b) return false;
    const na = a.toLowerCase().replace(/[^a-z0-9]/g, '');
    const nb = b.toLowerCase().replace(/[^a-z0-9]/g, '');
    const n = Math.min(8, na.length, nb.length);
    return n > 0 && (na.slice(0, n) === nb.slice(0, n) || na.includes(nb.slice(0, n)) || nb.includes(na.slice(0, n)));
  }

  function cardKey(card, preview) {
    const salesId = extractSalesLeadId(card);
    if (salesId) return `sales:${salesId}`;
    const inUrl = normalizeInUrl(extractUrlFromCard(card));
    if (inUrl) return `in:${inUrl.split('/in/')[1]}`;
    return `name:${(preview?.name || '').toLowerCase()}`;
  }

  function extractUrlFromCard(card) {
    for (const link of card.querySelectorAll('a[href*="/in/"]')) {
      const url = normalizeInUrl(link.getAttribute('href'));
      if (url) return url;
    }
    return '';
  }

  function preferPublicUrl(a, b) {
    return normalizeInUrl(a) || normalizeInUrl(b) || '';
  }

  function mergeLeadRecords(base, incoming) {
    if (!base) return incoming;
    if (!incoming) return base;
    const url = preferPublicUrl(incoming.url, base.url) ||
      (incoming.publicIdentifier ? `https://www.linkedin.com/in/${incoming.publicIdentifier}` : '') ||
      (base.publicIdentifier ? `https://www.linkedin.com/in/${base.publicIdentifier}` : '');

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
      publicIdentifier: incoming.publicIdentifier || base.publicIdentifier || '',
      url: normalizeInUrl(url),
      source: incoming.source || base.source
    };
  }

  function normalizeLeadRecord(lead) {
    let url = '';
    if (lead?.publicIdentifier) {
      const slug = String(lead.publicIdentifier).replace(/^\/in\//, '').split('?')[0];
      if (slug) url = `https://www.linkedin.com/in/${slug}`;
    }
    url = url || normalizeInUrl(lead?.url);
    if (url && url.includes('/sales/')) url = '';

    return {
      ...lead,
      url,
      email: ScraperUtils.normalizeText(lead?.email || ''),
      phone: ScraperUtils.normalizeText(lead?.phone || '')
    };
  }

  function isLeadCard(card) {
    if (!card) return false;
    if (card.querySelector('a[href*="/sales/lead/"], a[href*="/in/"]')) return true;
    return Boolean(queryFirst(card, sel.name));
  }

  function findResultCards() {
    for (const selector of sel.card || []) {
      const items = document.querySelectorAll(selector);
      if (!items.length) continue;
      const cards = Array.from(items).filter(isLeadCard);
      if (cards.length) return cards;
    }

    const linkCards = [];
    const seen = new Set();
    document.querySelectorAll('a[href*="/sales/lead/"], a[href*="/in/"]').forEach((link) => {
      const container = link.closest('li, [role="listitem"], [data-view-name="search-results-entity"], div[class*="result"]');
      if (container && !seen.has(container)) {
        seen.add(container);
        linkCards.push(container);
      }
    });
    return linkCards;
  }

  function extractLeadFromCard(card) {
    let name = queryText(card, sel.name);
    if (!name) {
      const link = queryFirst(card, sel.name) || card.querySelector('a[href*="/sales/lead/"]');
      if (link) name = ScraperUtils.normalizeText(link.textContent);
    }
    return {
      name,
      title: queryText(card, sel.title),
      company: queryText(card, sel.company),
      url: extractUrlFromCard(card),
      location: queryText(card, sel.location),
      industry: queryText(card, sel.industry),
      email: '',
      phone: '',
      salesLeadId: extractSalesLeadId(card),
      source: 'list'
    };
  }

  function findClickTarget(card) {
    return (
      card.querySelector('a[data-anonymize="person-name"]') ||
      card.querySelector('a[href*="/sales/lead/"]') ||
      queryFirst(card, sel.name) ||
      queryFirst(card, sel.url)
    );
  }

  function findLeadPanel() {
    for (const selector of sel.leadPanel || []) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    const inLink = document.querySelector(
      'a[href*="/in/"][data-control-name], a[aria-label*="View LinkedIn profile" i], a[aria-label*="LinkedIn profile" i]'
    );
    if (inLink) {
      return inLink.closest('section, aside, div[role="dialog"], div[role="complementary"]') || document.body;
    }
    return document.body;
  }

  function extractContactFromRoot(root) {
    root = root || document.body;
    let email = '';
    let phone = '';
    let url = '';

    root.querySelectorAll('a[href*="/in/"]').forEach((a) => {
      if (!url) url = normalizeInUrl(a.getAttribute('href'));
    });

    for (const selector of sel.publicProfileLink || ['a[href*="/in/"]']) {
      root.querySelectorAll(selector).forEach((a) => {
        if (!url) url = normalizeInUrl(a.getAttribute('href'));
      });
    }

    root.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
      if (!email) email = a.getAttribute('href').replace(/^mailto:/i, '').split('?')[0];
    });

    root.querySelectorAll('a[href^="tel:"]').forEach((a) => {
      if (!phone) phone = a.getAttribute('href').replace(/^tel:/i, '').trim();
    });

    for (const selector of sel.contactEmail || ['[data-anonymize="email"]']) {
      root.querySelectorAll(selector).forEach((el) => {
        if (!email) email = ScraperUtils.normalizeText(el.textContent);
      });
    }

    for (const selector of sel.contactPhone || ['[data-anonymize="phone"]']) {
      root.querySelectorAll(selector).forEach((el) => {
        if (!phone) phone = ScraperUtils.normalizeText(el.textContent);
      });
    }

    const text = root.innerText || root.textContent || '';
    if (!email) {
      const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (match) email = match[0];
    }
    if (!phone) {
      const match = text.match(/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
      if (match) phone = match[0].trim();
    }

    return {
      url,
      email: ScraperUtils.normalizeText(email),
      phone: ScraperUtils.normalizeText(phone),
      name: queryText(root, sel.name),
      title: queryText(root, sel.title),
      company: queryText(root, sel.company),
      location: queryText(root, sel.location),
      industry: queryText(root, sel.industry),
      source: 'panel'
    };
  }

  function mergeApiMatches(preview, salesLeadId) {
    let merged = { ...preview };
    const apiLeads = NetworkIntercept.getLinkedInLeads();

    for (const api of apiLeads) {
      const matchBySales = salesLeadId && api.salesLeadId === salesLeadId;
      const matchByName = namesMatch(api.name, preview.name);
      const matchById = salesLeadId && api.url?.includes(salesLeadId);
      if (matchBySales || matchByName || matchById) {
        merged = mergeLeadRecords(merged, api);
      }
    }

    if (salesLeadId) {
      const bySales = NetworkIntercept.getLinkedInLeadBySalesId(salesLeadId);
      if (bySales) merged = mergeLeadRecords(merged, bySales);
    }

    return merged;
  }

  async function closeLeadPanel() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    const closeBtn = document.querySelector(
      'button[aria-label*="Dismiss" i], button[aria-label*="Close" i], button[aria-label*="Back" i]'
    );
    closeBtn?.click();
    await ScraperUtils.sleep(350);
  }

  async function clickLeadAndEnrich(card, preview) {
    const salesLeadId = preview.salesLeadId || extractSalesLeadId(card);
    const apiCountBefore = NetworkIntercept.getLinkedInLeads().length;
    const clickTarget = findClickTarget(card);

    if (!clickTarget) throw new Error('Could not find lead click target');

    try {
      clickTarget.scrollIntoView({ block: 'center', behavior: 'auto' });
    } catch {
      clickTarget.scrollIntoView(true);
    }
    await ScraperUtils.sleep(350);

    ScraperUtils.log(SCOPE, 'Opening lead panel for:', preview.name || salesLeadId);
    clickTarget.click();

    await ScraperUtils.waitForCondition(() => {
      const panel = findLeadPanel();
      const contact = extractContactFromRoot(panel);
      const apiGrew = NetworkIntercept.getLinkedInLeads().length > apiCountBefore;
      return Boolean(
        contact.url ||
        contact.email ||
        contact.phone ||
        apiGrew ||
        document.querySelector('a[href*="/in/"]')
      );
    }, { timeoutMs: 15000, pollMs: 200 });

    await ScraperUtils.sleep(900);

    let record = mergeLeadRecords(preview, extractContactFromRoot(findLeadPanel()));
    record = mergeApiMatches(record, salesLeadId);

    if (!record.url?.includes('/in/')) {
      await ScraperUtils.sleep(1200);
      record = mergeApiMatches(mergeLeadRecords(record, extractContactFromRoot(findLeadPanel())), salesLeadId);
    }

    await closeLeadPanel();
    return normalizeLeadRecord(record);
  }

  async function sendProgress() {
    Watchdog.touch();
    const remaining = Math.max(0, progress.total - progress.processed);
    const avgMs = progress.processed > 0 ? progress.elapsedMs / progress.processed : 2000;
    await chrome.runtime.sendMessage({
      type: ScraperConstants.MSG.PROGRESS_UPDATE,
      scraperType: ScraperConstants.SCRAPER_LINKEDIN,
      progress: {
        total: progress.total,
        processed: progress.processed,
        remaining,
        success: progress.success,
        failed: progress.failed,
        etaSeconds: Math.round((remaining * avgMs) / 1000)
      }
    }).catch(() => {});
  }

  function recordKey(record) {
    const slug = record.url?.match(/\/in\/([^/?#]+)/i)?.[1];
    if (slug) return `in:${slug.toLowerCase()}`;
    if (record.salesLeadId) return `sales:${record.salesLeadId}`;
    return `name:${(record.name || '').toLowerCase()}`;
  }

  async function collectRecord(lead) {
    const record = normalizeLeadRecord(lead);

    if (!record.url?.includes('/in/')) {
      ScraperUtils.warn(SCOPE, 'No public /in/ URL for:', record.name || 'unknown');
      return false;
    }

    const key = recordKey(record);
    if (processedKeys.has(key)) return true;

    for (let attempt = 0; attempt < ScraperConstants.MAX_RETRIES; attempt++) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: ScraperConstants.MSG.RECORD_COLLECTED,
          scraperType: ScraperConstants.SCRAPER_LINKEDIN,
          record
        });
        processedKeys.add(key);
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

  async function scrollToLoadAllCards() {
    const container = queryFirst(document, sel.feedContainer);
    let stable = 0;
    let lastCount = 0;

    for (let i = 0; i < 250; i++) {
      if (!(await ScraperUtils.waitWhilePaused())) break;

      const count = findResultCards().length;
      if (count > lastCount) {
        lastCount = count;
        stable = 0;
        progress.total = Math.max(progress.total, count);
        await sendProgress();
      } else {
        stable++;
      }

      if (container) container.scrollTop = container.scrollHeight;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await ScraperUtils.sleep(350);
      if (stable >= 8) break;
    }

    return findResultCards();
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
    }, { timeoutMs: 10000 });
    await ScraperUtils.sleepJitter(1000);
  }

  async function processCards(cards, delayMs) {
    progress.total = Math.max(progress.total, cards.length);
    await sendProgress();

    for (const card of cards) {
      if (!(await ScraperUtils.waitWhilePaused())) return false;

      const preview = extractLeadFromCard(card);
      const key = cardKey(card, preview);
      if (processedKeys.has(key)) {
        progress.processed++;
        continue;
      }

      progress.processed++;
      progress.elapsedMs = Date.now() - progress.startTime;

      let record = null;
      for (let attempt = 0; attempt < ScraperConstants.MAX_RETRIES; attempt++) {
        try {
          record = await clickLeadAndEnrich(card, preview);
          if (record?.url?.includes('/in/')) break;
          throw new Error('Missing public profile URL after panel extract');
        } catch (err) {
          ScraperUtils.error(SCOPE, `Panel extract attempt ${attempt + 1}:`, err);
          if (attempt < ScraperConstants.MAX_RETRIES - 1) {
            await ScraperUtils.sleepJitter(800 * (attempt + 1));
          }
        }
      }

      if (record?.url?.includes('/in/')) {
        ScraperUtils.log(SCOPE, 'Saved lead:', record);
        await collectRecord(record);
      } else {
        progress.failed++;
        ScraperUtils.warn(SCOPE, 'Could not resolve /in/ URL for:', preview.name);
      }

      await sendProgress();
      if (delayMs > 0) await ScraperUtils.sleepJitter(delayMs);
    }

    return true;
  }

  async function stallRecovery() {
    ScraperUtils.warn(SCOPE, 'Stall recovery — re-scroll cards');
    window.scrollTo(0, 0);
    await ScraperUtils.sleep(500);
    const cards = findResultCards().filter((c) => !processedKeys.has(cardKey(c, extractLeadFromCard(c))));
    if (cards.length) await processCards(cards.slice(0, 5), 400);
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
    const delayMs = Math.max(400, Number.isFinite(Number(settings.delayMs)) ? Number(settings.delayMs) : 800);
    const collectAllPages = Boolean(settings.collectAllPages);

    await ScraperUtils.waitForElement(sel.card || sel.url, { timeoutMs: 12000 });
    await ScraperUtils.sleepJitter(800);

    let pageNum = 1;

    while (true) {
      if (!(await ScraperUtils.waitWhilePaused())) break;

      const cards = await scrollToLoadAllCards();
      ScraperUtils.log(SCOPE, `Page ${pageNum}: processing ${cards.length} lead cards via panel click`);
      await processCards(cards, delayMs);

      if (!collectAllPages) break;

      const nextBtn = findNextPageButton();
      if (!nextBtn) break;

      const prevUrl = location.href;
      const prevCount = findResultCards().length;
      nextBtn.click();
      await waitForPageChange(prevUrl, prevCount);
      pageNum++;
      await ScraperUtils.sleepJitter(600);
    }

    await RetryQueue.processAll(collectRecord, { delayMs: 600 });
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
    const sample = cards.length ? extractLeadFromCard(cards[0]) : {};
    return {
      cardsFound: cards.length,
      apiLeads: NetworkIntercept.getLinkedInLeads().length,
      sampleExtracted: sample,
      selectorsOk: Boolean(cards.length)
    };
  }

  return { run, verifySelectors, findResultCards, extractLeadFromCard };
});
