/* GitHub Test Lens — settings schema, defaults and chrome.storage helpers.
 * Classic script shared by content script, options, popup and the service worker (importScripts). */
(function (root) {
  'use strict';

  const GHTL = root.GHTL || (root.GHTL = {});

  const CATEGORIES = ['prod', 'test', 'support', 'bench'];
  const FILTERS = ['all', 'prod', 'tests'];
  const COLLAPSE_MODES = ['off', 'test', 'all-tests'];
  const MAX_CUSTOM_RULES = 300;
  const MAX_LABEL = 24;

  const DEFAULTS = Object.freeze({
    version: 1,
    enabled: true,
    badges: { test: true, support: true, bench: true, prod: false },
    tint: true,
    summary: true,
    autoCollapse: 'off',
    defaultFilter: 'all',
    surfaces: { diff: true, tree: true, repoTree: true, blob: true, search: true },
    labels: { test: 'TEST', support: 'TEST SUPPORT', bench: 'BENCH', prod: 'PROD' },
    disabledRuleIds: [],
    actionBadge: true,
    hideTestsInTotals: false,
  });

  const KEYS = { settings: 'settings', customRules: 'customRules', gheHosts: 'gheHosts' };

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function sanitizeSettings(raw) {
    const s = clone(DEFAULTS);
    if (!isObj(raw)) return s;
    if (typeof raw.enabled === 'boolean') s.enabled = raw.enabled;
    if (typeof raw.tint === 'boolean') s.tint = raw.tint;
    if (typeof raw.summary === 'boolean') s.summary = raw.summary;
    if (typeof raw.actionBadge === 'boolean') s.actionBadge = raw.actionBadge;
    if (typeof raw.hideTestsInTotals === 'boolean') s.hideTestsInTotals = raw.hideTestsInTotals;
    if (COLLAPSE_MODES.includes(raw.autoCollapse)) s.autoCollapse = raw.autoCollapse;
    if (FILTERS.includes(raw.defaultFilter)) s.defaultFilter = raw.defaultFilter;
    if (isObj(raw.badges)) for (const c of CATEGORIES) if (typeof raw.badges[c] === 'boolean') s.badges[c] = raw.badges[c];
    if (isObj(raw.surfaces)) for (const k of Object.keys(s.surfaces)) if (typeof raw.surfaces[k] === 'boolean') s.surfaces[k] = raw.surfaces[k];
    if (isObj(raw.labels)) for (const c of CATEGORIES) {
      if (typeof raw.labels[c] === 'string') {
        const v = raw.labels[c].trim().slice(0, MAX_LABEL);
        if (v) s.labels[c] = v;
      }
    }
    if (Array.isArray(raw.disabledRuleIds)) {
      s.disabledRuleIds = Array.from(new Set(raw.disabledRuleIds.filter((x) => typeof x === 'string' && x.length < 80))).slice(0, 1000);
    }
    return s;
  }

  function sanitizeCustomRule(raw) {
    if (!isObj(raw) || typeof raw.pattern !== 'string') return null;
    const pattern = raw.pattern.trim().slice(0, 300);
    if (!pattern) return null;
    const category = CATEGORIES.includes(raw.category) ? raw.category : 'test';
    const repo = typeof raw.repo === 'string' ? raw.repo.trim().toLowerCase().slice(0, 200) : '';
    const enabled = raw.enabled !== false;
    return { pattern, category, repo, enabled };
  }

  function sanitizeCustomRules(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(sanitizeCustomRule).filter(Boolean).slice(0, MAX_CUSTOM_RULES);
  }

  const ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{2,5})?$/i;

  function normalizeOrigin(input) {
    let v = String(input || '').trim().toLowerCase();
    if (!v) return null;
    if (!/^[a-z]+:\/\//.test(v)) v = 'https://' + v;
    v = v.replace(/^([a-z]+:\/\/[^/?#]+).*$/i, '$1'); // strip any path, query or fragment (keeps scheme://host[:port])
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:') return null;
      const origin = u.origin.toLowerCase();
      if (!ORIGIN_RE.test(origin)) return null;
      if (origin === 'https://github.com') return null; // built-in
      return origin;
    } catch (e) { return null; }
  }

  function sanitizeHosts(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const h of raw) {
      const o = normalizeOrigin(h);
      if (o && !out.includes(o)) out.push(o);
    }
    return out.slice(0, 50);
  }

  function validateCustomRule(rule) {
    const r = sanitizeCustomRule(rule);
    if (!r) return { ok: false, error: 'Pattern is required' };
    try {
      GHTL.classifier.compileGlob(r.pattern);
      if (r.repo) GHTL.classifier.compileGlob(r.repo.includes('/') ? r.repo : r.repo + '/*');
      return { ok: true, rule: r };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  function hasStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync;
  }

  async function load() {
    if (!hasStorage()) return { settings: clone(DEFAULTS), customRules: [], gheHosts: [] };
    const got = await chrome.storage.sync.get([KEYS.settings, KEYS.customRules, KEYS.gheHosts]);
    return {
      settings: sanitizeSettings(got[KEYS.settings]),
      customRules: sanitizeCustomRules(got[KEYS.customRules]),
      gheHosts: sanitizeHosts(got[KEYS.gheHosts]),
    };
  }

  /** Bytes chrome.storage.sync charges for one item: key length + JSON of the value (UTF-8). */
  function itemBytes(key, value) {
    const json = JSON.stringify(value);
    const len = typeof TextEncoder === 'function' ? new TextEncoder().encode(json).length : unescape(encodeURIComponent(json)).length;
    return String(key).length + len;
  }

  function customRulesBytes(rules) {
    return itemBytes(KEYS.customRules, sanitizeCustomRules(rules));
  }

  /** save({ settings?: partial, customRules?: [], gheHosts?: [] }, { base? }) — partial settings are
   * deep-merged (one level: badges/labels merge key by key) onto `base` when given, else onto the stored
   * value. With `base` no storage read happens first, so the write is dispatched synchronously (needed
   * when a page is being closed). Custom rules are written as their own item and rejected with a readable
   * error when they exceed Chrome's 8 KB per-item sync quota; the other parts of the patch still save. */
  async function save(patch, opts) {
    if (!hasStorage()) throw new Error('chrome.storage.sync unavailable');
    const toWrite = {};
    if (patch && isObj(patch.settings)) {
      const base = opts && isObj(opts.base) ? sanitizeSettings(opts.base) : (await load()).settings;
      const merged = clone(base);
      for (const [k, v] of Object.entries(patch.settings)) {
        if (isObj(v) && isObj(merged[k])) Object.assign(merged[k], v);
        else merged[k] = v;
      }
      toWrite[KEYS.settings] = sanitizeSettings(merged);
    }
    if (patch && Array.isArray(patch.gheHosts)) toWrite[KEYS.gheHosts] = sanitizeHosts(patch.gheHosts);
    let rules = null;
    if (patch && Array.isArray(patch.customRules)) rules = sanitizeCustomRules(patch.customRules);
    const writes = [];
    if (Object.keys(toWrite).length) writes.push(chrome.storage.sync.set(toWrite));
    let rulesError = null;
    if (rules) {
      const bytes = itemBytes(KEYS.customRules, rules);
      if (bytes > QUOTA.bytesPerItem) {
        rulesError = new Error('Custom rules take ' + bytes.toLocaleString('en-US') + ' bytes; Chrome sync allows '
          + QUOTA.bytesPerItem.toLocaleString('en-US') + ' per item. Remove or shorten some rules.');
      } else {
        writes.push(chrome.storage.sync.set({ [KEYS.customRules]: rules }));
        toWrite[KEYS.customRules] = rules;
      }
    }
    await Promise.all(writes);
    if (rulesError) { rulesError.partial = toWrite; throw rulesError; }
    return toWrite;
  }

  async function reset() {
    if (!hasStorage()) return;
    await chrome.storage.sync.set({ [KEYS.settings]: clone(DEFAULTS), [KEYS.customRules]: [] });
  }

  /** onChange(cb) → unsubscribe. cb(changes) fires for any of our keys in the sync area. */
  function onChange(cb) {
    if (!hasStorage() || !chrome.storage.onChanged) return () => {};
    const listener = (changes, area) => {
      if (area !== 'sync') return;
      if (changes[KEYS.settings] || changes[KEYS.customRules] || changes[KEYS.gheHosts]) cb(changes);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  function exportJSON(data) {
    return JSON.stringify({
      ghtl: 1,
      exportedAt: new Date().toISOString(),
      settings: sanitizeSettings(data.settings),
      customRules: sanitizeCustomRules(data.customRules),
      gheHosts: sanitizeHosts(data.gheHosts),
    }, null, 2);
  }

  function importJSON(text) {
    let parsed;
    try { parsed = JSON.parse(String(text)); } catch (e) { throw new Error('Not valid JSON: ' + e.message); }
    if (!isObj(parsed)) throw new Error('Expected a JSON object');
    return {
      settings: sanitizeSettings(parsed.settings),
      customRules: sanitizeCustomRules(parsed.customRules),
      gheHosts: sanitizeHosts(parsed.gheHosts),
    };
  }

  async function bytesInUse() {
    if (!hasStorage() || !chrome.storage.sync.getBytesInUse) return 0;
    return chrome.storage.sync.getBytesInUse(null);
  }

  const QUOTA = { bytes: 102400, bytesPerItem: 8192 };

  GHTL.settings = {
    DEFAULTS, KEYS, CATEGORIES, FILTERS, COLLAPSE_MODES, MAX_CUSTOM_RULES, itemBytes, customRulesBytes,
    sanitizeSettings, sanitizeCustomRule, sanitizeCustomRules, sanitizeHosts, normalizeOrigin, validateCustomRule,
    load, save, reset, onChange, exportJSON, importJSON, bytesInUse,
    QUOTA,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = GHTL.settings;
})(typeof globalThis !== 'undefined' ? globalThis : this);
