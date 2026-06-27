/* global self */
(function initModuleLoader() {
  const root = typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : window;

  if (root.__scraperDefine) return;

  root.__scraperDefine = function (name, factory) {
    if (root[name]) return root[name];
    const value = factory();
    root[name] = value;
    return value;
  };
})();
