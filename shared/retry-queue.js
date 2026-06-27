/* global self, ScraperUtils, __scraperDefine */
__scraperDefine('RetryQueue', () => {
  const SCOPE = 'retry-queue';
  const failed = [];

  function add(record, reason) {
    failed.push({ record, reason, addedAt: Date.now() });
    ScraperUtils.warn(SCOPE, 'Queued for retry:', reason, record?.name || record?.url);
  }

  function size() {
    return failed.length;
  }

  function clear() {
    failed.length = 0;
  }

  async function processAll(saveFn, options = {}) {
    if (!failed.length) return { retried: 0, recovered: 0 };

    const maxRetries = options.maxRetries ?? 3;
    const delayMs = options.delayMs ?? 800;
    const items = failed.splice(0, failed.length);
    let recovered = 0;

    ScraperUtils.log(SCOPE, `Final retry pass for ${items.length} failed records`);

    for (const item of items) {
      let success = false;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          success = await saveFn(item.record);
          if (success) {
            recovered++;
            break;
          }
        } catch (err) {
          ScraperUtils.error(SCOPE, `Retry attempt ${attempt + 1} failed:`, err);
        }
        await ScraperUtils.sleep(delayMs * (attempt + 1));
      }
    }

    return { retried: items.length, recovered };
  }

  return { add, size, clear, processAll };
});
