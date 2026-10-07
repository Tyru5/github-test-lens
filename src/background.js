/* GitHub Test Lens — service worker (Manifest V3).
 * Owns the toolbar badge (share of changed lines that are tests, per tab), the per-tab cache the
 * popup reads, the keyboard commands, and the dynamically registered content scripts for GitHub
 * Enterprise hosts. Classic worker script: settings.js comes in through importScripts (no ES
 * modules). Every listener is registered synchronously at the top level so Chrome can wake the
 * worker for it, and nothing kept in memory is assumed to survive between events. */
'use strict';

try {
  importScripts('settings.js');
} catch (e) {
  console.debug('[ghtl] importScripts(settings.js) failed', e);
}

(function (root) {
  const GHTL = root.GHTL || (root.GHTL = {});

  const DIFF_KINDS = ['pr-files', 'pr-commit', 'commit', 'compare'];
  const BADGE_BG = '#8250df'; // Primer "done" purple: the hue the in-page badges use
  const BADGE_BG_WARN = '#bf8700'; // Primer "attention": code changed, no tests touched
  const BADGE_FG = '#ffffff';
  const EMPTY_BADGE = Object.freeze({ text: '', color: BADGE_BG });
  const SESSION_PREFIX = 'tab:';
  const GHE_SCRIPT_PREFIX = 'ghtl-ghe-';
  const COMMAND_MESSAGES = { 'cycle-filter': 'ghtl:cycle-filter', 'toggle-collapse': 'ghtl:toggle-collapse' };

  // ---- small helpers ------------------------------------------------------------------------

  function debug() {
    if (root.console && root.console.debug) root.console.debug.apply(root.console, ['[ghtl]'].concat(Array.prototype.slice.call(arguments)));
  }

  function errorMessage(e) {
    return e && e.message ? String(e.message) : String(e);
  }

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function hasChrome() {
    return typeof chrome !== 'undefined' && !!chrome.runtime;
  }

  function settingsApi() {
    if (!GHTL.settings) throw new Error('settings module not loaded');
    return GHTL.settings;
  }

  /** Runs an event handler body; failures are logged, never thrown back into the event loop. */
  function run(label, fn) {
    let p;
    try {
      p = Promise.resolve(fn());
    } catch (e) {
      p = Promise.reject(e);
    }
    return p.catch((e) => debug(label + ' failed:', errorMessage(e)));
  }

  /** Resolves `promise` into sendResponse: { ok: false, error } on failure. */
  function reply(sendResponse, promise) {
    const send = (value) => {
      try {
        sendResponse(value);
      } catch (e) {
        debug('sendResponse failed (port closed?):', errorMessage(e));
      }
    };
    Promise.resolve(promise)
      .then((res) => send(res === undefined ? { ok: true } : res))
      .catch((e) => {
        debug('message handler failed:', errorMessage(e));
        send({ ok: false, error: errorMessage(e) });
      });
  }

  // Script registration must not interleave (two concurrent registers of the same id would race),
  // so everything that touches chrome.scripting runs through this chain. It only serialises work
  // inside one worker lifetime; there is nothing in it that needs to persist.
  let chain = Promise.resolve();
  function serialized(fn) {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  }

  function senderTabId(sender) {
    const id = sender && sender.tab && sender.tab.id;
    return Number.isInteger(id) && id >= 0 ? id : null;
  }

  /** True unless the sender is demonstrably a web page (a content script carries the page URL). */
  function isPrivilegedSender(sender) {
    if (!sender) return false;
    const base = chrome.runtime.getURL('');
    if (typeof sender.url === 'string' && sender.url) return sender.url.startsWith(base);
    if (typeof sender.origin === 'string' && sender.origin) return base.startsWith(sender.origin);
    return true;
  }

  async function activeTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs[0] && Number.isInteger(tabs[0].id) ? tabs[0] : null;
    } catch (e) {
      debug('tabs.query failed:', errorMessage(e));
      return null;
    }
  }

  // ---- badge ---------------------------------------------------------------------------------

  /** Badge for one tab: { text, color }. Text is at most 4 characters ("100%"). */
  function badgeFor(stats, kind, settings) {
    if (settings && (settings.actionBadge === false || settings.enabled === false)) return EMPTY_BADGE;
    if (!isObj(stats) || DIFF_KINDS.indexOf(kind) === -1) return EMPTY_BADGE;
    if (stats.warning) return { text: '0%', color: BADGE_BG_WARN };
    const share = stats.testShare;
    if (share == null || !Number.isFinite(Number(share))) return EMPTY_BADGE;
    const pct = Math.max(0, Math.min(100, Math.round(Number(share))));
    return { text: (pct + '%').slice(0, 4), color: BADGE_BG };
  }

  async function applyBadge(tabId, badge) {
    if (!chrome.action) return;
    try {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
      if (typeof chrome.action.setBadgeTextColor === 'function') {
        await chrome.action.setBadgeTextColor({ tabId, color: BADGE_FG });
      }
      await chrome.action.setBadgeText({ tabId, text: badge.text });
    } catch (e) {
      debug('badge update failed for tab', tabId, errorMessage(e)); // tab usually gone
    }
  }

  // ---- per-tab state (chrome.storage.session) -------------------------------------------------

  function stripHash(u) {
    const i = String(u).indexOf('#');
    return i === -1 ? String(u) : String(u).slice(0, i);
  }

  function sessionKey(tabId) {
    return SESSION_PREFIX + tabId;
  }

  function sessionArea() {
    return chrome.storage && chrome.storage.session ? chrome.storage.session : null;
  }

  async function setTabState(tabId, state) {
    const area = sessionArea();
    if (area) await area.set({ [sessionKey(tabId)]: state });
  }

  async function getTabState(tabId) {
    const area = sessionArea();
    if (!area) return null;
    const key = sessionKey(tabId);
    const got = await area.get(key);
    return got && isObj(got[key]) ? got[key] : null;
  }

  async function removeTabState(tabId) {
    const area = sessionArea();
    if (area) await area.remove(sessionKey(tabId));
  }

  /** Re-applies every cached tab's badge (after the badge or enabled setting changed). */
  async function refreshAllBadges() {
    const area = sessionArea();
    if (!area) return;
    const settings = (await settingsApi().load()).settings;
    const all = await area.get(null);
    for (const key of Object.keys(all || {})) {
      if (key.indexOf(SESSION_PREFIX) !== 0) continue;
      const tabId = Number(key.slice(SESSION_PREFIX.length));
      const entry = all[key];
      if (!Number.isInteger(tabId) || !isObj(entry)) continue;
      await applyBadge(tabId, badgeFor(entry.stats, entry.kind, settings));
    }
  }

  // ---- GitHub Enterprise content scripts (chrome.scripting) -----------------------------------

  /** "https://ghe.example.com:8443" → "ghtl-ghe-ghe.example.com-8443". */
  function gheScriptId(origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch (e) {
      host = String(origin || '').replace(/^[a-z]+:\/\//i, '');
    }
    return GHE_SCRIPT_PREFIX + host.toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
  }

  /** "https://github.com/login*" → "/login*": the manifest's exclusions, re-applied on another origin. */
  function excludePathsOf(patterns) {
    const out = [];
    for (const p of Array.isArray(patterns) ? patterns : []) {
      const m = /^[a-z*]+:\/\/[^/]+(\/.*)$/i.exec(String(p));
      if (m && m[1] !== '/*') out.push(m[1]);
    }
    return out;
  }

  /** The github.com content script from the manifest, re-targeted at a GHE origin. */
  function gheScriptSpec(origin) {
    const manifest = chrome.runtime.getManifest();
    const base = (manifest.content_scripts && manifest.content_scripts[0]) || {};
    const spec = {
      id: gheScriptId(origin),
      matches: [origin + '/*'],
      js: Array.isArray(base.js) ? base.js.slice() : [],
      css: Array.isArray(base.css) ? base.css.slice() : [],
      runAt: 'document_idle',
      allFrames: false,
      world: base.world || 'ISOLATED',
      persistAcrossSessions: true,
    };
    const excludes = excludePathsOf(base.exclude_matches).map((p) => origin + p);
    if (excludes.length) spec.excludeMatches = excludes;
    return spec;
  }

  async function hasOriginPermission(origin) {
    try {
      return !!(await chrome.permissions.contains({ origins: [origin + '/*'] }));
    } catch (e) {
      debug('permissions.contains failed:', errorMessage(e));
      return false;
    }
  }

  async function getRegistered(ids) {
    try {
      const list = await chrome.scripting.getRegisteredContentScripts(ids ? { ids } : undefined);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      debug('getRegisteredContentScripts failed:', errorMessage(e));
      return [];
    }
  }

  async function registerGheScript(origin) {
    const spec = gheScriptSpec(origin);
    const existing = await getRegistered([spec.id]);
    if (existing.length) {
      await chrome.scripting.updateContentScripts([spec]);
      return 'updated';
    }
    try {
      await chrome.scripting.registerContentScripts([spec]);
      return 'registered';
    } catch (e) {
      if (!/duplicate/i.test(errorMessage(e))) throw e;
      await chrome.scripting.updateContentScripts([spec]);
      return 'updated';
    }
  }

  async function unregisterGheScript(origin) {
    const id = gheScriptId(origin);
    const existing = await getRegistered([id]);
    if (!existing.length) return false;
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
    return true;
  }

  /** Reconciles gheHosts with what chrome.scripting has: registers the missing (and permitted),
   * refreshes the existing (keeps js/css lists current after an update), drops the stale. */
  /** Hosts dropped from the list outside the options page (import, sync from another machine):
   * revoke their optional host permission too, so access never outlives the setting. */
  async function revokeDroppedHosts(oldHosts, newHosts) {
    const S = settingsApi();
    const keep = new Set(S.sanitizeHosts(newHosts));
    const dropped = S.sanitizeHosts(oldHosts).filter((o) => !keep.has(o));
    if (!dropped.length || !chrome.permissions) return;
    try {
      await chrome.permissions.remove({ origins: dropped.map((o) => o + '/*') });
    } catch (e) {
      debug('revoking dropped GHE permissions failed:', errorMessage(e));
    }
  }

  async function syncGheScripts() {
    if (!chrome.scripting) return;
    const hosts = (await settingsApi().load()).gheHosts;
    const wanted = new Map();
    for (const origin of hosts) wanted.set(gheScriptId(origin), origin);

    const ours = (await getRegistered()).filter((s) => s && typeof s.id === 'string' && s.id.indexOf(GHE_SCRIPT_PREFIX) === 0);
    const stale = [];
    const live = new Set();
    for (const s of ours) {
      const origin = wanted.get(s.id);
      if (origin && (await hasOriginPermission(origin))) live.add(s.id);
      else stale.push(s.id);
    }
    if (stale.length) {
      try {
        await chrome.scripting.unregisterContentScripts({ ids: stale });
      } catch (e) {
        debug('unregister stale GHE scripts failed:', errorMessage(e));
      }
    }
    for (const [id, origin] of wanted) {
      if (!(await hasOriginPermission(origin))) continue; // granted later from the options page
      try {
        const spec = gheScriptSpec(origin);
        if (live.has(id)) await chrome.scripting.updateContentScripts([spec]);
        else await chrome.scripting.registerContentScripts([spec]);
      } catch (e) {
        debug('GHE script sync failed for', origin, errorMessage(e));
      }
    }
  }

  // ---- defaults ------------------------------------------------------------------------------

  /** Writes DEFAULTS once, only when nothing is stored yet. Never overwrites. */
  async function seedDefaults() {
    const S = settingsApi();
    const keys = S.KEYS;
    const got = await chrome.storage.sync.get([keys.settings, keys.customRules, keys.gheHosts]);
    if (got[keys.settings] !== undefined) return false;
    const seed = { [keys.settings]: JSON.parse(JSON.stringify(S.DEFAULTS)) };
    if (got[keys.customRules] === undefined) seed[keys.customRules] = [];
    if (got[keys.gheHosts] === undefined) seed[keys.gheHosts] = [];
    await chrome.storage.sync.set(seed);
    return true;
  }

  // ---- message handlers ----------------------------------------------------------------------

  async function handleStats(msg, sender) {
    const tabId = senderTabId(sender);
    if (tabId == null) return { ok: false, error: 'ghtl:stats must come from a tab' };
    const stats = isObj(msg.stats) ? msg.stats : null;
    const kind = typeof msg.kind === 'string' ? msg.kind : 'other';
    const url = typeof msg.url === 'string' ? msg.url : String((sender.tab && sender.tab.url) || sender.url || '');
    await setTabState(tabId, { stats, kind, url });
    const settings = (await settingsApi().load()).settings;
    await applyBadge(tabId, badgeFor(stats, kind, settings));
    return { ok: true };
  }

  async function handleGetTabState(msg, sender) {
    const asked = Number(msg.tabId);
    let tabId = Number.isInteger(asked) && asked >= 0 ? asked : senderTabId(sender);
    if (tabId == null) {
      const tab = await activeTab();
      tabId = tab ? tab.id : null;
    }
    if (tabId == null) return { ok: false, error: 'No tab' };
    const entry = await getTabState(tabId);
    return {
      ok: true,
      tabId,
      found: !!entry,
      state: entry,
      stats: entry ? entry.stats : null,
      kind: entry ? entry.kind : null,
      url: entry ? entry.url : null,
    };
  }

  async function handleGheAdd(msg, sender) {
    if (!isPrivilegedSender(sender)) return { ok: false, error: 'Not allowed from a web page' };
    const S = settingsApi();
    const origin = S.normalizeOrigin(msg.origin);
    if (!origin) return { ok: false, error: 'Not a valid https origin: ' + String(msg.origin || '') };
    if (!(await hasOriginPermission(origin))) return { ok: false, error: 'Permission for ' + origin + ' was not granted' };
    await registerGheScript(origin);
    const hosts = (await S.load()).gheHosts;
    if (hosts.indexOf(origin) === -1) {
      const written = await S.save({ gheHosts: hosts.concat(origin) });
      if ((written.gheHosts || []).indexOf(origin) === -1) {
        await unregisterGheScript(origin); // keep storage and registrations in step
        return { ok: false, error: 'Could not save ' + origin + ' (host list full or rejected)' };
      }
    }
    return { ok: true, origin, scriptId: gheScriptId(origin) };
  }

  async function handleGheRemove(msg, sender) {
    if (!isPrivilegedSender(sender)) return { ok: false, error: 'Not allowed from a web page' };
    const S = settingsApi();
    const origin = S.normalizeOrigin(msg.origin);
    if (!origin) return { ok: false, error: 'Not a valid https origin: ' + String(msg.origin || '') };
    try {
      await unregisterGheScript(origin);
    } catch (e) {
      debug('unregister failed for', origin, errorMessage(e));
    }
    try {
      await chrome.permissions.remove({ origins: [origin + '/*'] });
    } catch (e) {
      debug('permissions.remove failed for', origin, errorMessage(e));
    }
    const hosts = (await S.load()).gheHosts;
    if (hosts.indexOf(origin) !== -1) await S.save({ gheHosts: hosts.filter((h) => h !== origin) });
    return { ok: true, origin };
  }

  // ---- listeners (all synchronous, top level) ---------------------------------------------------

  if (hasChrome()) {
    chrome.runtime.onInstalled.addListener((details) => {
      run('onInstalled', async () => {
        debug('installed:', details && details.reason);
        await seedDefaults();
        await serialized(syncGheScripts);
      });
    });

    chrome.runtime.onStartup.addListener(() => {
      run('onStartup', () => serialized(syncGheScripts));
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      try {
        const type = isObj(msg) && typeof msg.type === 'string' ? msg.type : '';
        switch (type) {
          case 'ghtl:stats':
            reply(sendResponse, handleStats(msg, sender));
            return true;
          case 'ghtl:get-tab-state':
            reply(sendResponse, handleGetTabState(msg, sender));
            return true;
          case 'ghtl:ghe-add':
            reply(sendResponse, serialized(() => handleGheAdd(msg, sender)));
            return true;
          case 'ghtl:ghe-remove':
            reply(sendResponse, serialized(() => handleGheRemove(msg, sender)));
            return true;
          default:
            // Page-level messages (ghtl:get-state, ghtl:set-filter, ...) go to tabs, never here.
            if (type.indexOf('ghtl:') === 0) sendResponse({ ok: false, error: 'Unknown message type ' + type });
            return false;
        }
      } catch (e) {
        debug('onMessage failed:', errorMessage(e));
        try {
          sendResponse({ ok: false, error: errorMessage(e) });
        } catch (e2) {
          debug('sendResponse failed:', errorMessage(e2));
        }
        return false;
      }
    });

    if (chrome.permissions && chrome.permissions.onRemoved) {
      chrome.permissions.onRemoved.addListener((perms) => {
        const origins = perms && Array.isArray(perms.origins) ? perms.origins : [];
        if (!origins.length) return;
        run('permissions.onRemoved', () => serialized(async () => {
          for (const pattern of origins) {
            const origin = GHTL.settings ? GHTL.settings.normalizeOrigin(pattern) : null;
            if (!origin) continue; // wildcard pattern: the full sync below handles it
            try {
              await unregisterGheScript(origin);
            } catch (e) {
              debug('unregister after permission removal failed:', errorMessage(e));
            }
          }
          await syncGheScripts();
        }));
      });
    }

    if (chrome.tabs) {
      chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (!changeInfo || changeInfo.status !== 'loading') return;
        run('tabs.onUpdated', async () => {
          // Same-document navigations (#diff-… anchors, Back/Forward between them) also report
          // status 'loading', but the content script has nothing new to report: keep the badge.
          const url = stripHash((tab && tab.url) || changeInfo.url || '');
          if (url) {
            const prev = await getTabState(tabId);
            if (prev && typeof prev.url === 'string' && stripHash(prev.url) === url) return;
          }
          await applyBadge(tabId, EMPTY_BADGE);
          await removeTabState(tabId); // the content script reports fresh stats once the page is up
        });
      });

      chrome.tabs.onRemoved.addListener((tabId) => {
        run('tabs.onRemoved', () => removeTabState(tabId));
      });
    }

    if (chrome.commands && chrome.commands.onCommand) {
      chrome.commands.onCommand.addListener((command, tab) => {
        const type = COMMAND_MESSAGES[command];
        if (!type) return;
        run('commands.onCommand', async () => {
          const target = tab && Number.isInteger(tab.id) && tab.id >= 0 ? tab : await activeTab();
          if (!target) return;
          try {
            await chrome.tabs.sendMessage(target.id, { type });
          } catch (e) {
            debug('no Test Lens content script in tab', target.id, errorMessage(e));
          }
        });
      });
    }

    if (GHTL.settings) {
      GHTL.settings.onChange((changes) => {
        if (changes.gheHosts) {
          const { oldValue, newValue } = changes.gheHosts;
          run('gheHosts changed', () => serialized(async () => {
            await revokeDroppedHosts(Array.isArray(oldValue) ? oldValue : [], Array.isArray(newValue) ? newValue : []);
            await syncGheScripts();
          }));
        }
        if (changes.settings) run('settings changed', refreshAllBadges);
      });
    }
  }

  GHTL.background = {
    DIFF_KINDS, BADGE_BG, BADGE_BG_WARN, BADGE_FG, SESSION_PREFIX, GHE_SCRIPT_PREFIX,
    badgeFor, sessionKey, gheScriptId, gheScriptSpec, excludePathsOf,
    seedDefaults, syncGheScripts, refreshAllBadges,
    handleStats, handleGetTabState, handleGheAdd, handleGheRemove,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = GHTL.background;
})(typeof globalThis !== 'undefined' ? globalThis : this);
