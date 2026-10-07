/* GitHub Test Lens — options page.
 * Classic script loaded after patterns.js, classifier.js and settings.js. The pure helpers are
 * exposed on GHTL.options (and module.exports) so node can require this file; everything that
 * touches the DOM or chrome.* lives in initPage(), which only runs inside a document. */
(function (root) {
  'use strict';

  const GHTL = root.GHTL || (root.GHTL = {});

  const SAVE_DEBOUNCE_MS = 300;
  const TRY_DEBOUNCE_MS = 120;
  const TOAST_MS = 1800;
  const MAX_LABEL = 24;
  const CATEGORY_ORDER = ['test', 'support', 'bench', 'prod'];
  const CATEGORY_NAMES = { test: 'Test', support: 'Test support', bench: 'Benchmark', prod: 'Production' };
  // Keyed by the first segment of the built-in rule ids (src/patterns.js).
  const GROUP_LABELS = {
    generic: 'Generic', js: 'JavaScript / TypeScript', py: 'Python', go: 'Go', jvm: 'Java / Kotlin / Scala / JVM',
    clj: 'Clojure', dotnet: 'C# / F# / .NET', rb: 'Ruby', php: 'PHP', rust: 'Rust', swift: 'Swift / Objective-C',
    dart: 'Dart / Flutter', ex: 'Elixir', erl: 'Erlang', hs: 'Haskell', ocaml: 'OCaml', cpp: 'C / C++', perl: 'Perl',
    r: 'R', jl: 'Julia', lua: 'Lua', sh: 'Shell', zig: 'Zig', nim: 'Nim', tf: 'Terraform', iac: 'Infrastructure as code',
    sol: 'Solidity', elm: 'Elm', cr: 'Crystal', gleam: 'Gleam', sql: 'SQL', hdl: 'Hardware description (Verilog / VHDL)',
  };

  // ---------------------------------------------------------------------------------------------
  // Pure helpers (no DOM, no chrome.*) — also exported for node.
  // ---------------------------------------------------------------------------------------------

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function errorMessage(e) {
    return e && e.message ? String(e.message) : String(e);
  }

  /** Trailing-edge debounce with .cancel() and .pending(). */
  function debounce(fn, ms) {
    let timer = null;
    let lastArgs = null;
    function run() {
      timer = null;
      const args = lastArgs || [];
      lastArgs = null;
      fn.apply(null, args);
    }
    function debounced() {
      lastArgs = Array.prototype.slice.call(arguments);
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, ms);
    }
    debounced.cancel = function () {
      if (timer) clearTimeout(timer);
      timer = null;
      lastArgs = null;
    };
    debounced.pending = function () {
      return timer !== null;
    };
    return debounced;
  }

  function getPath(obj, path) {
    return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  function setPath(obj, path, value) {
    const keys = String(path).split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
    return obj;
  }

  function groupKey(id) {
    return String(id || '').split('.')[0] || 'other';
  }

  function groupLabel(key) {
    if (GROUP_LABELS[key]) return GROUP_LABELS[key];
    const k = String(key || 'other');
    return k.charAt(0).toUpperCase() + k.slice(1);
  }

  /** Group catalog rules by the first id segment ("js.test-suffix" → "js"): Generic first, then
   * alphabetical by display label; rules keep catalog order inside a group. */
  function groupRules(rules) {
    const map = new Map();
    (rules || []).forEach((rule) => {
      if (!rule || !rule.id) return;
      const key = groupKey(rule.id);
      if (!map.has(key)) map.set(key, { key, label: groupLabel(key), rules: [] });
      map.get(key).rules.push(rule);
    });
    return Array.from(map.values()).sort((a, b) => {
      if (a.key === b.key) return 0;
      if (a.key === 'generic') return -1;
      if (b.key === 'generic') return 1;
      return a.label.localeCompare(b.label);
    });
  }

  function searchText(rule) {
    return [
      rule.id, rule.description, rule.category, rule.confidence,
      (rule.ecosystems || []).join(' '), groupLabel(groupKey(rule.id)),
    ].join(' ').toLowerCase();
  }

  /** Every whitespace-separated token of the query must occur in the rule's id, description,
   * category, confidence, ecosystems or group label. Empty query matches everything. */
  function matchesSearch(rule, query) {
    const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const hay = searchText(rule);
    return tokens.every((t) => hay.includes(t));
  }

  function formatInt(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function storageLine(used, quota) {
    const u = Math.max(0, Number(used) || 0);
    const q = Math.max(1, Number(quota) || 1);
    const percent = Math.min(100, Math.round((u / q) * 100));
    return { used: u, quota: q, percent, text: formatInt(u) + ' of ' + formatInt(q) + ' bytes used (' + percent + '%)' };
  }

  function snapshotEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function importSummary(data) {
    const rules = Array.isArray(data.customRules) ? data.customRules.length : 0;
    const hosts = Array.isArray(data.gheHosts) ? data.gheHosts.length : 0;
    const off = data.settings && Array.isArray(data.settings.disabledRuleIds) ? data.settings.disabledRuleIds.length : 0;
    return 'Replace your current settings with the imported file?\n\nIt contains ' +
      plural(rules, 'custom rule') + ', ' + plural(hosts, 'Enterprise host') + ' and ' +
      plural(off, 'disabled built-in rule') + '. This cannot be undone.';
  }

  /** Classifier built from the options form state (not from storage), for "Try a path". */
  function buildClassifier(state, repo) {
    return GHTL.classifier.createClassifier({
      rules: GHTL.patterns.rules,
      prodOverrides: GHTL.patterns.prodOverrides,
      ignoreRules: GHTL.patterns.ignore,
      userRules: state.customRules,
      disabledRuleIds: state.settings.disabledRuleIds,
      repo: repo || '',
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Page
  // ---------------------------------------------------------------------------------------------

  function initPage() {
    const doc = root.document;
    const settingsApi = GHTL.settings;
    const chromeApi = typeof root.chrome !== 'undefined' && root.chrome ? root.chrome : null;

    // Working copy the form edits, and the last snapshot of storage we loaded or wrote. A storage
    // change whose content equals `known` is our own write and is ignored; anything else came from
    // another page (popup, another options tab, sync) and triggers a re-render.
    const state = { settings: clone(settingsApi.DEFAULTS), customRules: [], gheHosts: [] };
    let known = { settings: clone(settingsApi.DEFAULTS), customRules: [], gheHosts: [] };
    const pending = { settings: null, customRules: false, gheHosts: false };
    let inflight = null;
    let recheck = false;
    let toastTimer = null;
    let builtinRows = null;

    function $(id) {
      const node = doc.getElementById(id);
      if (!node) throw new Error('Missing element #' + id);
      return node;
    }

    function el(tag, attrs, children) {
      const node = doc.createElement(tag);
      if (attrs) {
        Object.keys(attrs).forEach((k) => {
          const v = attrs[k];
          if (v == null || v === false) return;
          if (k === 'className') node.className = v;
          else if (k === 'text') node.textContent = v;
          else if (k === 'dataset') Object.keys(v).forEach((d) => { node.dataset[d] = v[d]; });
          else if (k === 'checked' || k === 'value' || k === 'hidden' || k === 'disabled') node[k] = v;
          else node.setAttribute(k, v === true ? '' : String(v));
        });
      }
      (children || []).forEach((c) => {
        if (c == null) return;
        node.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
      });
      return node;
    }

    function setInvalid(input, errEl, message) {
      if (errEl) errEl.textContent = message || '';
      if (!input) return;
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }

    function toast(message) {
      const t = $('toast');
      t.textContent = message;
      t.classList.add('is-visible');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        t.classList.remove('is-visible');
        t.textContent = '';
        toastTimer = null;
      }, TOAST_MS);
    }

    function showSaveError(message) {
      $('save-error-text').textContent = message || '';
      $('save-error').hidden = !message;
    }

    // Re-render helpers rebuild rows; keep focus (and caret) on the equivalent control.
    function findFocusKey(key) {
      const nodes = doc.querySelectorAll('[data-focus-key]');
      for (let i = 0; i < nodes.length; i++) if (nodes[i].dataset.focusKey === key) return nodes[i];
      return null;
    }

    function withFocus(fn) {
      const active = doc.activeElement;
      const key = active && active.dataset ? active.dataset.focusKey : null;
      let sel = null;
      if (key && typeof active.selectionStart === 'number') sel = [active.selectionStart, active.selectionEnd];
      fn();
      if (!key) return;
      const next = findFocusKey(key);
      if (!next) return;
      next.focus();
      if (sel && typeof next.setSelectionRange === 'function') {
        try { next.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text control */ }
      }
    }

    // ---- saving --------------------------------------------------------------------------------

    function mergePending(patch, newerWins) {
      if (patch.settings) {
        pending.settings = newerWins
          ? Object.assign(pending.settings || {}, patch.settings)
          : Object.assign({}, patch.settings, pending.settings || {});
      }
      if (patch.customRules) pending.customRules = true;
      if (patch.gheHosts) pending.gheHosts = true;
    }

    function hasPending() {
      return !!(pending.settings || pending.customRules || pending.gheHosts);
    }

    function takePending() {
      if (!hasPending()) return null;
      const patch = {};
      if (pending.settings) patch.settings = pending.settings;
      if (pending.customRules) patch.customRules = clone(state.customRules);
      if (pending.gheHosts) patch.gheHosts = clone(state.gheHosts);
      pending.settings = null;
      pending.customRules = false;
      pending.gheHosts = false;
      return patch;
    }

    async function writePatch(patch) {
      try {
        const written = await settingsApi.save(patch);
        Object.keys(written).forEach((k) => { known[k] = written[k]; });
        showSaveError('');
        toast('Saved');
        refreshStorage();
      } catch (e) {
        console.debug('[ghtl]', e);
        mergePending(patch, false); // keep it for "Retry" / the next edit
        if (e && e.partial) Object.keys(e.partial).forEach((k) => { known[k] = e.partial[k]; });
        showSaveError('Could not save: ' + errorMessage(e));
      }
    }

    async function flushSave() {
      if (inflight) {
        try { await inflight; } catch (e) { /* reported by writePatch */ }
      }
      const patch = takePending();
      if (!patch) return;
      inflight = writePatch(patch);
      try { await inflight; } finally { inflight = null; }
      // An external change arrived while we were saving: re-check now that nothing is in flight.
      if (recheck && !hasPending()) {
        recheck = false;
        externalCheck().catch((e) => console.debug('[ghtl]', e));
      }
    }

    const scheduleSave = debounce(() => {
      flushSave().catch((e) => console.debug('[ghtl]', e));
    }, SAVE_DEBOUNCE_MS);

    function queueSave(patch) {
      mergePending(patch, true);
      scheduleSave();
    }

    async function flushNow() {
      scheduleSave.cancel();
      await flushSave();
    }

    function adopt(data) {
      known = clone(data);
      state.settings = clone(data.settings);
      state.customRules = clone(data.customRules);
      state.gheHosts = clone(data.gheHosts);
      renderAll();
      refreshStorage();
    }

    async function externalCheck() {
      if (inflight || scheduleSave.pending()) {
        recheck = true;
        return;
      }
      try {
        const data = await settingsApi.load();
        if (snapshotEqual(data, known)) return;
        adopt(data);
        toast('Settings reloaded');
      } catch (e) {
        console.debug('[ghtl]', e);
      }
    }

    async function reloadFromStorage() {
      await flushNow();
      adopt(await settingsApi.load());
    }

    // ---- general / behavior (static inputs with data-setting="a.b") ------------------------------

    function renderStatic() {
      doc.querySelectorAll('[data-setting]').forEach((input) => {
        const value = getPath(state.settings, input.dataset.setting);
        if (input.type === 'checkbox') input.checked = !!value;
        else {
          const str = value == null ? '' : String(value);
          if (input.value !== str) input.value = str;
        }
      });
    }

    function patchForKey(key) {
      const top = key.split('.')[0];
      const patch = {};
      patch[top] = clone(state.settings[top]);
      return { settings: patch };
    }

    function errorFor(input) {
      const id = input.getAttribute('aria-describedby');
      return id ? doc.getElementById(id) : null;
    }

    function onStaticChange(ev) {
      const input = ev.target;
      if (!input || !input.dataset || !input.dataset.setting || input.type === 'text') return;
      const key = input.dataset.setting;
      const value = input.type === 'checkbox' ? input.checked : input.value;
      setPath(state.settings, key, value);
      queueSave(patchForKey(key));
    }

    function onLabelInput(ev) {
      const input = ev.target;
      if (!input || !input.dataset || !input.dataset.setting || input.type !== 'text') return;
      const key = input.dataset.setting;
      const value = input.value.trim().slice(0, MAX_LABEL);
      if (!value) {
        setInvalid(input, errorFor(input), 'A label cannot be empty.');
        return;
      }
      setInvalid(input, errorFor(input), '');
      setPath(state.settings, key, value);
      queueSave(patchForKey(key));
    }

    function onLabelBlur(ev) {
      const input = ev.target;
      if (!input || !input.dataset || !input.dataset.setting || input.type !== 'text') return;
      if (input.value.trim()) return;
      input.value = String(getPath(state.settings, input.dataset.setting) || '');
      setInvalid(input, errorFor(input), '');
    }

    // ---- custom rules ---------------------------------------------------------------------------

    function ruleRow(rule, i) {
      const n = String(i + 1);
      const errId = 'rule-error-' + i;
      const pattern = el('input', {
        type: 'text', value: rule.pattern || '', 'aria-label': 'Pattern for rule ' + n, 'aria-describedby': errId,
        placeholder: 'e.g. **/*.spec.ts or /regex/i', spellcheck: 'false', autocomplete: 'off',
        dataset: { field: 'pattern', focusKey: 'rule-' + i + '-pattern' },
      });
      const category = el('select', {
        'aria-label': 'Category for rule ' + n, dataset: { field: 'category', focusKey: 'rule-' + i + '-category' },
      }, CATEGORY_ORDER.map((c) => el('option', { value: c, text: CATEGORY_NAMES[c] + (c === 'prod' ? ' (force)' : '') })));
      category.value = CATEGORY_ORDER.includes(rule.category) ? rule.category : 'test';
      const repo = el('input', {
        type: 'text', value: rule.repo || '', 'aria-label': 'Repository scope for rule ' + n,
        placeholder: 'all repositories', spellcheck: 'false', autocomplete: 'off',
        dataset: { field: 'repo', focusKey: 'rule-' + i + '-repo' },
      });
      const enabled = el('input', {
        type: 'checkbox', checked: rule.enabled !== false, 'aria-label': 'Rule ' + n + ' enabled',
        dataset: { field: 'enabled', focusKey: 'rule-' + i + '-enabled' },
      });
      const del = el('button', {
        type: 'button', className: 'btn btn--small btn--danger', text: 'Delete', 'aria-label': 'Delete rule ' + n,
        dataset: { action: 'delete', focusKey: 'rule-' + i + '-delete' },
      });
      return el('tr', { dataset: { index: String(i) } }, [
        el('td', null, [pattern, el('p', { className: 'field-error', id: errId })]),
        el('td', null, [category]),
        el('td', null, [repo]),
        el('td', { className: 'cell-center' }, [enabled]),
        el('td', { className: 'cell-actions' }, [del]),
      ]);
    }

    function rowIndex(target) {
      const tr = target && target.closest ? target.closest('tr[data-index]') : null;
      return tr ? Number(tr.dataset.index) : -1;
    }

    function validateRow(i) {
      const body = $('rules-body');
      const tr = body.querySelector('tr[data-index="' + i + '"]');
      if (!tr) return;
      const input = tr.querySelector('[data-field="pattern"]');
      const err = tr.querySelector('.field-error');
      const rule = state.customRules[i];
      if (!String(rule.pattern || '').trim()) {
        setInvalid(input, err, '');
        err.textContent = 'Enter a pattern to activate this rule.';
        err.classList.add('is-hint');
        return;
      }
      err.classList.remove('is-hint');
      const v = settingsApi.validateCustomRule(rule);
      setInvalid(input, err, v.ok ? '' : v.error);
    }

    function renderRules() {
      const body = $('rules-body');
      withFocus(() => {
        body.textContent = '';
        state.customRules.forEach((rule, i) => body.appendChild(ruleRow(rule, i)));
      });
      const count = state.customRules.length;
      const max = settingsApi.MAX_CUSTOM_RULES;
      $('rules-table').hidden = count === 0;
      $('rules-empty').hidden = count > 0;
      const bytes = settingsApi.customRulesBytes(state.customRules);
      const cap = settingsApi.QUOTA.bytesPerItem;
      const full = count >= max || bytes > cap - 120; // room for one more typical rule
      $('rules-count').textContent = count + (count === 1 ? ' rule' : ' rules') + ' · ' + bytes.toLocaleString('en-US') + ' of '
        + cap.toLocaleString('en-US') + ' bytes Chrome sync allows for rules';
      $('add-rule').disabled = full;
      $('add-rule').title = full ? 'Rule storage is full: remove or shorten a rule first' : '';
      state.customRules.forEach((rule, i) => validateRow(i));
    }

    function wireRules() {
      const body = $('rules-body');
      body.addEventListener('input', (ev) => {
        const t = ev.target;
        const i = rowIndex(t);
        if (i < 0 || !t.dataset.field || t.type !== 'text') return;
        state.customRules[i][t.dataset.field] = t.value;
        validateRow(i);
        queueSave({ customRules: true });
        renderTryDebounced();
      });
      body.addEventListener('change', (ev) => {
        const t = ev.target;
        const i = rowIndex(t);
        if (i < 0 || !t.dataset.field) return;
        if (t.type === 'checkbox') state.customRules[i].enabled = t.checked;
        else if (t.tagName === 'SELECT') state.customRules[i].category = t.value;
        else return;
        queueSave({ customRules: true });
        renderTryDebounced();
      });
      body.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action="delete"]') : null;
        const i = rowIndex(btn);
        if (!btn || i < 0) return;
        state.customRules.splice(i, 1);
        renderRules();
        queueSave({ customRules: true });
        renderTryDebounced();
        const next = findFocusKey('rule-' + Math.min(i, state.customRules.length - 1) + '-delete');
        (next || $('add-rule')).focus();
      });
      $('add-rule').addEventListener('click', () => {
        if ($('add-rule').disabled) return;
        state.customRules.push({ pattern: '', category: 'test', repo: '', enabled: true });
        renderRules();
        const input = findFocusKey('rule-' + (state.customRules.length - 1) + '-pattern');
        if (input) input.focus();
      });
    }

    // ---- try a path -----------------------------------------------------------------------------

    function renderTry() {
      const out = $('try-result');
      const raw = $('try-path').value.trim();
      const repo = $('try-repo').value.trim().toLowerCase();
      out.textContent = '';
      if (!raw) {
        out.appendChild(el('p', { className: 'hint', text: 'Type a repository-relative path to see how the rules above classify it. End it with "/" to test a directory.' }));
        return;
      }
      let cls, ex;
      try {
        cls = buildClassifier(state, repo);
        ex = cls.explain(raw, { isDir: /\/$/.test(raw) });
      } catch (e) {
        console.debug('[ghtl]', e);
        out.appendChild(el('p', { className: 'field-error', text: 'Could not classify: ' + errorMessage(e) }));
        return;
      }
      const r = ex.result;
      out.appendChild(el('p', { className: 'try-head' }, [
        el('span', { className: 'cat-pill cat-pill--' + r.category, text: CATEGORY_NAMES[r.category] || r.category }),
        r.ignored ? el('span', { className: 'tag tag--warn', text: 'ignored: excluded from statistics' }) : null,
        el('span', { className: 'muted', text: 'confidence ' + r.confidence }),
      ]));
      out.appendChild(el('dl', { className: 'kv' }, [
        el('dt', { text: 'Path' }), el('dd', null, [el('code', { text: ex.isDir ? ex.path + '/' : ex.path })]),
        el('dt', { text: 'Rule' }), el('dd', null, [r.ruleId ? el('code', { text: r.ruleId }) : 'none']),
        el('dt', { text: 'Reason' }), el('dd', { text: r.reason }),
      ]));
      if (ex.matches.length) {
        out.appendChild(el('h4', { text: 'Matching rules (' + ex.matches.length + ')' }));
        out.appendChild(el('ol', { className: 'match-list' }, ex.matches.map((m) => el('li', null, [
          el('code', { text: m.ruleId }),
          ' ' + (CATEGORY_NAMES[m.category] || m.category) + ', ' + m.confidence + ' confidence, ' +
            m.scope + ' "' + m.matched + '"' + (m.user ? ' (custom rule)' : ''),
        ]))));
      } else {
        out.appendChild(el('p', { className: 'muted', text: 'No rule matched; production by default.' }));
      }
      if (cls.errors.length) {
        out.appendChild(el('p', { className: 'field-error', text: 'Skipped rules: ' + cls.errors.join('; ') }));
      }
    }

    const renderTryDebounced = debounce(() => {
      try { renderTry(); } catch (e) { console.debug('[ghtl]', e); }
    }, TRY_DEBOUNCE_MS);

    // ---- built-in rules -------------------------------------------------------------------------

    function buildBuiltins() {
      const list = $('builtin-list');
      list.textContent = '';
      builtinRows = new Map();
      groupRules(GHTL.patterns.rules).forEach((g) => {
        const ul = el('ul', { className: 'rule-list' });
        g.rules.forEach((rule) => {
          const id = 'builtin-' + rule.id;
          const cb = el('input', { type: 'checkbox', id, dataset: { ruleId: rule.id } });
          const li = el('li', { className: 'rule-row' }, [
            cb,
            el('label', { for: id }, [
              el('code', { className: 'rule-id', text: rule.id }),
              ' ',
              el('span', { className: 'rule-desc', text: rule.description || '' }),
            ]),
            el('span', { className: 'tag tag--' + rule.category, text: CATEGORY_NAMES[rule.category] || rule.category }),
            el('span', { className: 'tag tag--conf-' + rule.confidence, text: rule.confidence, title: 'Confidence' }),
          ]);
          ul.appendChild(li);
          builtinRows.set(rule.id, { li, cb, rule });
        });
        list.appendChild(el('section', { className: 'rule-group', 'aria-label': g.label }, [
          el('h3', null, [g.label + ' ', el('span', { className: 'muted', text: '(' + g.rules.length + ')' })]),
          ul,
        ]));
      });
      list.addEventListener('change', (ev) => {
        const cb = ev.target;
        if (!cb || !cb.dataset || !cb.dataset.ruleId) return;
        const set = new Set(state.settings.disabledRuleIds);
        if (cb.checked) set.delete(cb.dataset.ruleId);
        else set.add(cb.dataset.ruleId);
        state.settings.disabledRuleIds = Array.from(set);
        queueSave({ settings: { disabledRuleIds: clone(state.settings.disabledRuleIds) } });
        updateBuiltinCount();
        renderTryDebounced();
      });
    }

    function updateBuiltinCount() {
      const disabled = new Set(state.settings.disabledRuleIds);
      let off = 0;
      builtinRows.forEach((row, id) => { if (disabled.has(id)) off++; });
      $('builtin-count').textContent = (builtinRows.size - off) + ' of ' + builtinRows.size + ' rules enabled';
      $('enable-all').disabled = state.settings.disabledRuleIds.length === 0;
    }

    function applySearch() {
      const query = $('rule-search').value;
      let visible = 0;
      const groups = new Map();
      builtinRows.forEach((row) => {
        const show = matchesSearch(row.rule, query);
        row.li.hidden = !show;
        const section = row.li.closest('.rule-group');
        if (section) groups.set(section, (groups.get(section) || 0) + (show ? 1 : 0));
        if (show) visible++;
      });
      groups.forEach((n, section) => { section.hidden = n === 0; });
      $('builtin-none').hidden = visible > 0;
    }

    function syncBuiltins() {
      if (!builtinRows) buildBuiltins();
      const disabled = new Set(state.settings.disabledRuleIds);
      builtinRows.forEach((row, id) => { row.cb.checked = !disabled.has(id); });
      updateBuiltinCount();
      applySearch();
    }

    function wireBuiltins() {
      $('rule-search').addEventListener('input', () => {
        try { applySearch(); } catch (e) { console.debug('[ghtl]', e); }
      });
      $('enable-all').addEventListener('click', () => {
        state.settings.disabledRuleIds = [];
        syncBuiltins();
        queueSave({ settings: { disabledRuleIds: [] } });
        renderTryDebounced();
      });
    }

    // ---- GitHub Enterprise hosts ----------------------------------------------------------------

    async function checkHostPermission(origin, status, grant) {
      if (!chromeApi || !chromeApi.permissions) {
        status.textContent = '';
        return;
      }
      try {
        const ok = await chromeApi.permissions.contains({ origins: [origin + '/*'] });
        status.textContent = ok ? 'Active' : 'Permission missing';
        status.className = 'host-status ' + (ok ? 'is-ok' : 'is-warn');
        grant.hidden = ok;
      } catch (e) {
        console.debug('[ghtl]', e);
        status.textContent = '';
      }
    }

    function renderHosts() {
      const list = $('ghe-list');
      withFocus(() => {
        list.textContent = '';
        state.gheHosts.forEach((origin) => {
          const status = el('span', { className: 'host-status muted', text: chromeApi ? 'Checking…' : '' });
          const grant = el('button', {
            type: 'button', className: 'btn btn--small', text: 'Grant permission', hidden: true,
            'aria-label': 'Grant permission for ' + origin, dataset: { action: 'grant', origin, focusKey: 'host-grant-' + origin },
          });
          const remove = el('button', {
            type: 'button', className: 'btn btn--small btn--danger', text: 'Remove',
            'aria-label': 'Remove ' + origin, dataset: { action: 'remove', origin, focusKey: 'host-remove-' + origin },
          });
          list.appendChild(el('li', null, [el('span', { className: 'host-origin', text: origin }), status, grant, remove]));
          checkHostPermission(origin, status, grant);
        });
      });
      $('ghe-empty').hidden = state.gheHosts.length > 0;
    }

    function sendMessage(msg) {
      if (!chromeApi || !chromeApi.runtime || !chromeApi.runtime.sendMessage) {
        return Promise.reject(new Error('Extension APIs are unavailable on this page.'));
      }
      return chromeApi.runtime.sendMessage(msg);
    }

    // Must be called synchronously from a user gesture (click / submit): permissions.request
    // needs it. Grants the host permission, then asks the service worker to register the scripts.
    async function addHost(origin) {
      if (!chromeApi || !chromeApi.permissions) throw new Error('Extension APIs are unavailable on this page.');
      const granted = await chromeApi.permissions.request({ origins: [origin + '/*'] });
      if (!granted) throw new Error('Permission for ' + origin + ' was not granted.');
      const resp = await sendMessage({ type: 'ghtl:ghe-add', origin });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'The extension could not register the host.');
    }

    function wireHosts() {
      const input = $('ghe-input');
      const err = $('ghe-error');
      $('ghe-form').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const origin = settingsApi.normalizeOrigin(input.value);
        if (!origin) {
          setInvalid(input, err, 'Enter an https:// origin such as https://github.example.com (github.com is built in).');
          return;
        }
        setInvalid(input, err, '');
        addHost(origin)
          .then(() => { input.value = ''; toast('Host added'); return reloadFromStorage(); })
          .catch((e) => { console.debug('[ghtl]', e); setInvalid(input, err, errorMessage(e)); });
      });
      $('ghe-list').addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
        if (!btn) return;
        const origin = btn.dataset.origin;
        btn.disabled = true;
        setInvalid(null, err, '');
        const work = btn.dataset.action === 'remove'
          ? sendMessage({ type: 'ghtl:ghe-remove', origin }).then((resp) => {
            if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'The extension could not remove the host.');
            toast('Host removed');
          })
          : addHost(origin).then(() => toast('Permission granted'));
        work.then(() => reloadFromStorage())
          .catch((e) => { console.debug('[ghtl]', e); btn.disabled = false; setInvalid(null, err, errorMessage(e)); });
      });
    }

    // After an import the hosts are stored but nothing is registered: ask the worker to register
    // every host whose permission this profile already has (the others show "Grant permission").
    async function syncImportedHosts(hosts) {
      if (!chromeApi || !chromeApi.permissions) return;
      for (const origin of hosts) {
        try {
          if (await chromeApi.permissions.contains({ origins: [origin + '/*'] })) {
            await sendMessage({ type: 'ghtl:ghe-add', origin });
          }
        } catch (e) { console.debug('[ghtl]', e); }
      }
      renderHosts();
    }

    // ---- import / export ------------------------------------------------------------------------

    function wireImportExport() {
      const err = $('io-error');
      $('export').addEventListener('click', async () => {
        try {
          await flushNow();
          const text = settingsApi.exportJSON(await settingsApi.load());
          const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
          const a = el('a', { href: url, download: 'test-lens-settings.json' });
          doc.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          setInvalid(null, err, '');
          toast('Exported');
        } catch (e) {
          console.debug('[ghtl]', e);
          setInvalid(null, err, 'Export failed: ' + errorMessage(e));
        }
      });
      $('import').addEventListener('change', async (ev) => {
        const input = ev.target;
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        try {
          const data = settingsApi.importJSON(await file.text());
          if (!root.confirm(importSummary(data))) return;
          await flushNow();
          state.settings = clone(data.settings);
          state.customRules = clone(data.customRules);
          state.gheHosts = clone(data.gheHosts);
          mergePending({ settings: clone(data.settings), customRules: true, gheHosts: true }, true);
          await flushSave();
          renderAll();
          setInvalid(null, err, '');
          syncImportedHosts(data.gheHosts);
        } catch (e) {
          console.debug('[ghtl]', e);
          setInvalid(null, err, 'Import failed: ' + errorMessage(e));
        }
      });
    }

    // ---- storage --------------------------------------------------------------------------------

    async function refreshStorage() {
      try {
        const info = storageLine(await settingsApi.bytesInUse(), settingsApi.QUOTA.bytes);
        $('storage-line').textContent = info.text;
        const meter = $('storage-meter');
        meter.max = info.quota;
        meter.value = info.used;
        $('storage-warn').hidden = info.percent < 80;
      } catch (e) {
        console.debug('[ghtl]', e);
      }
    }

    function wireStorage() {
      $('reset').addEventListener('click', async () => {
        if (!root.confirm('Reset every setting and delete all custom rules?\n\nEnterprise hosts are kept. This cannot be undone.')) return;
        try {
          scheduleSave.cancel();
          pending.settings = null;
          pending.customRules = false;
          pending.gheHosts = false;
          if (inflight) {
            try { await inflight; } catch (e) { /* reported by writePatch */ }
          }
          await settingsApi.reset();
          adopt(await settingsApi.load());
          showSaveError('');
          toast('Reset to defaults');
        } catch (e) {
          console.debug('[ghtl]', e);
          showSaveError('Could not reset: ' + errorMessage(e));
        }
      });
    }

    // ---- boot -----------------------------------------------------------------------------------

    function renderAll() {
      renderStatic();
      renderRules();
      syncBuiltins();
      renderHosts();
      renderTry();
    }

    function wire() {
      doc.addEventListener('change', (ev) => {
        try { onStaticChange(ev); } catch (e) { console.debug('[ghtl]', e); }
      });
      doc.addEventListener('input', (ev) => {
        try { onLabelInput(ev); } catch (e) { console.debug('[ghtl]', e); }
      });
      doc.addEventListener('focusout', (ev) => {
        try { onLabelBlur(ev); } catch (e) { console.debug('[ghtl]', e); }
      });
      $('try-path').addEventListener('input', renderTryDebounced);
      $('try-repo').addEventListener('input', renderTryDebounced);
      $('save-retry').addEventListener('click', () => {
        showSaveError('');
        flushNow().catch((e) => console.debug('[ghtl]', e));
      });
      root.addEventListener('pagehide', () => {
        // The page is going away: dispatch the write synchronously (no storage read before it).
        if (!hasPending()) return;
        scheduleSave.cancel();
        const patch = takePending();
        if (patch) settingsApi.save(patch, { base: known.settings }).catch((e) => console.debug('[ghtl]', e));
      });
      wireRules();
      wireBuiltins();
      wireHosts();
      wireImportExport();
      wireStorage();
    }

    async function boot() {
      wire();
      const data = await settingsApi.load();
      adopt(data);
      settingsApi.onChange(() => {
        externalCheck().catch((e) => console.debug('[ghtl]', e));
      });
    }

    boot().catch((e) => {
      console.debug('[ghtl]', e);
      try { showSaveError('Could not load settings: ' + errorMessage(e)); } catch (e2) { console.debug('[ghtl]', e2); }
    });
  }

  GHTL.options = {
    SAVE_DEBOUNCE_MS, CATEGORY_ORDER, CATEGORY_NAMES, GROUP_LABELS,
    debounce, getPath, setPath, groupKey, groupLabel, groupRules, matchesSearch, searchText,
    formatInt, storageLine, snapshotEqual, importSummary, buildClassifier, errorMessage, initPage,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = GHTL.options;

  if (typeof root.document !== 'undefined' && root.document && typeof root.document.addEventListener === 'function') {
    try {
      if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', initPage);
      else initPage();
    } catch (e) {
      console.debug('[ghtl]', e);
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
