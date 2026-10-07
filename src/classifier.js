/* GitHub Test Lens — classification engine.
 * Pure module: no DOM, no chrome.* access. Loaded as a classic script (content script, options,
 * popup) and via require() in node tests. */
(function (root) {
  'use strict';

  const GHTL = root.GHTL || (root.GHTL = {});

  const CATEGORIES = ['prod', 'test', 'support', 'bench'];
  const SCOPES = ['segment', 'basename', 'path', 'name'];
  const RANK = { high: 3, medium: 2, low: 1 };
  // When two built-in rules of equal confidence match, the more specific role wins:
  // a fixture inside __tests__/ is "support", not "test".
  const TIE = { support: 3, bench: 2, test: 1, prod: 0 };
  const MAX_CACHE = 5000;

  const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;
  const RENAME_ARROW = /\s(?:→|=>|->)\s/; // "old/path.js → new/path.js"
  const BRACE_RENAME = /\{([^{}]*?)\s(?:→|=>|->)\s([^{}]*?)\}/g; // "src/{old => new}/f.js"

  function normalizePath(input) {
    if (input == null) return '';
    let p = String(input).replace(BIDI_MARKS, '').trim();
    if (!p) return '';
    p = p.replace(BRACE_RENAME, (m, a, b) => b); // "src/{old => new}/f.js" → "src/new/f.js"
    if (RENAME_ARROW.test(p)) {                   // "old/path.js → new/path.js" → new path
      const parts = p.split(RENAME_ARROW);
      p = parts[parts.length - 1].trim();
    }
    p = p.replace(/\\/g, '/');
    p = p.replace(/^(?:\.\/|\/)+/, '');
    p = p.replace(/\/\.(?=\/)/g, '');
    p = p.replace(/\/{2,}/g, '/');
    p = p.replace(/\/+$/, '');
    return p;
  }

  function splitPath(path, isDir) {
    const parts = path.split('/').filter(Boolean);
    if (isDir) return { segments: parts, basename: '' };
    return { segments: parts.slice(0, -1), basename: parts.length ? parts[parts.length - 1] : '' };
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  }

  // Translate one glob string (may contain {a,b} groups) into a regex source fragment.
  function translateGlob(g) {
    let out = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === '*') {
        if (g[i + 1] === '*') {
          let j = i + 2;
          while (g[j] === '*') j++;
          if (g[j] === '/') { out += '(?:.*/)?'; i = j; } // "**/" matches zero or more directories
          else { out += '.*'; i = j - 1; }
        } else {
          out += '[^/]*';
        }
      } else if (c === '?') {
        out += '[^/]';
      } else if (c === '{') {
        let depth = 0, end = -1;
        for (let j = i; j < g.length; j++) {
          if (g[j] === '{') depth++;
          else if (g[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
        }
        if (end === -1) { out += '\\{'; continue; }
        const inner = g.slice(i + 1, end);
        const alts = [];
        let d = 0, start = 0;
        for (let j = 0; j < inner.length; j++) {
          if (inner[j] === '{') d++;
          else if (inner[j] === '}') d--;
          else if (inner[j] === ',' && d === 0) { alts.push(inner.slice(start, j)); start = j + 1; }
        }
        alts.push(inner.slice(start));
        out += '(?:' + alts.map(translateGlob).join('|') + ')';
        i = end;
      } else if (c === '[') {
        const end = g.indexOf(']', i + 1);
        if (end === -1) { out += '\\['; continue; }
        let cls = g.slice(i + 1, end);
        if (cls[0] === '!') cls = '^' + cls.slice(1);
        out += '[' + cls.replace(/\\/g, '\\\\') + ']';
        i = end;
      } else {
        out += escapeRegExp(c);
      }
    }
    return out;
  }

  /** Compile a user pattern. `/regex/flags` literals are used as-is (path scope). Globs follow
   * gitignore-like semantics: no "/" → matches the file name or any directory name at any depth
   * (scope "name"); with "/" → anchored against the full repo-relative path (scope "path"). */
  function compileGlob(pattern) {
    const src = String(pattern == null ? '' : pattern).trim();
    if (!src) throw new Error('Pattern is empty');
    // "/regex/flags" — but only when the body uses regex-only syntax (\ ^ $ ( ) | +) or flags, so a
    // gitignore-style anchored directory such as "/build/" stays a glob.
    const lit = /^\/(.+)\/([a-z]*)$/s.exec(src);
    if (lit && (lit[2] || /[\\^$()|+]/.test(lit[1]))) {
      let regex;
      try { regex = new RegExp(lit[1], lit[2].replace(/[gy]/g, '')); }
      catch (e) { throw new Error('Invalid regex: ' + e.message); }
      return { regex, scope: 'path', kind: 'regex' };
    }
    let g = src.replace(/\\/g, '/');
    let scope = 'name';
    if (g.includes('/')) {
      scope = 'path';
      g = g.replace(/^\/+/, '');
      if (g.endsWith('/')) g += '**';
      if (!g) throw new Error('Pattern is empty');
    }
    let regex;
    try { regex = new RegExp('^' + translateGlob(g) + '$', 'i'); }
    catch (e) { throw new Error('Invalid pattern: ' + e.message); }
    return { regex, scope, kind: 'glob' };
  }

  function toRegExp(regex, flags) {
    if (regex instanceof RegExp) return regex;
    return new RegExp(String(regex), (flags || '').replace(/[gy]/g, ''));
  }

  function compileBuiltin(raw, index) {
    if (!raw || typeof raw !== 'object') throw new Error('Rule #' + index + ' is not an object');
    if (!CATEGORIES.includes(raw.category) || raw.category === 'prod') throw new Error('Rule ' + raw.id + ': bad category ' + raw.category);
    if (!SCOPES.includes(raw.scope)) throw new Error('Rule ' + raw.id + ': bad scope ' + raw.scope);
    const confidence = RANK[raw.confidence] ? raw.confidence : 'medium';
    return {
      id: String(raw.id || ('rule:' + index)),
      category: raw.category,
      scope: raw.scope,
      regex: toRegExp(raw.regex, raw.flags),
      confidence,
      rank: RANK[confidence],
      description: raw.description || '',
      ecosystems: Array.isArray(raw.ecosystems) ? raw.ecosystems : [],
      order: index,
    };
  }

  // Returns the matched string, or null.
  function matchRule(rule, parts, path) {
    const re = rule.regex;
    switch (rule.scope) {
      case 'basename':
        return parts.basename && re.test(parts.basename) ? parts.basename : null;
      case 'segment':
        for (let i = 0; i < parts.segments.length; i++) if (re.test(parts.segments[i])) return parts.segments[i];
        return null;
      case 'name':
        if (parts.basename && re.test(parts.basename)) return parts.basename;
        for (let i = 0; i < parts.segments.length; i++) if (re.test(parts.segments[i])) return parts.segments[i];
        return null;
      case 'path':
        return re.test(path) ? path : null;
      default:
        return null;
    }
  }

  function describe(rule, matched) {
    const what = rule.scope === 'path' ? 'path' : rule.scope === 'basename' ? 'file name' : 'directory';
    return what + ' "' + matched + '" matches ' + rule.id + ' ' + String(rule.regex);
  }

  /**
   * createClassifier({ rules, prodOverrides, userRules, disabledRuleIds, repo })
   *  rules:          built-in catalog entries ({ id, category, scope, regex, flags, confidence, ... })
   *  prodOverrides:  [{ id, regex, flags }] — force "prod" when the best match is low/medium confidence
   *  ignoreRules:    [{ id, regex, flags, onlyIfProd }] — full-path regexes for vendored/lockfile/generated
   *                  code: result is { category: 'prod', ignored: true } (excluded from PR statistics).
   *                  Without onlyIfProd the rule runs before the built-ins (vendored trees); with
   *                  onlyIfProd it applies only when nothing classified the file as a test (so a
   *                  *.map fixture under test/fixtures/ stays "support").
   *  userRules:      [{ pattern, category, repo, enabled }] — evaluated first, in order
   *  disabledRuleIds: built-in ids to skip
   *  repo:           "owner/name" (lowercase) of the current repository, for repo-scoped user rules
   */
  function createClassifier(options) {
    const opts = options || {};
    const errors = [];
    const disabled = new Set(Array.isArray(opts.disabledRuleIds) ? opts.disabledRuleIds : []);
    const repo = String(opts.repo || '').toLowerCase();

    const builtins = [];
    (opts.rules || []).forEach((raw, i) => {
      try {
        const r = compileBuiltin(raw, i);
        if (!disabled.has(r.id)) builtins.push(r);
      } catch (e) { errors.push(e.message); }
    });

    const overrides = [];
    (opts.prodOverrides || []).forEach((raw, i) => {
      try { overrides.push({ id: String(raw.id || ('override:' + i)), regex: toRegExp(raw.regex, raw.flags) }); }
      catch (e) { errors.push('Override ' + (raw && raw.id) + ': ' + e.message); }
    });

    const ignores = [];
    (opts.ignoreRules || []).forEach((raw, i) => {
      try { ignores.push({ id: String(raw.id || ('ignore:' + i)), regex: toRegExp(raw.regex, raw.flags), onlyIfProd: !!raw.onlyIfProd }); }
      catch (e) { errors.push('Ignore rule ' + (raw && raw.id) + ': ' + e.message); }
    });

    const users = [];
    (opts.userRules || []).forEach((raw, i) => {
      if (!raw || raw.enabled === false) return;
      try {
        if (!CATEGORIES.includes(raw.category)) throw new Error('Unknown category "' + raw.category + '"');
        const repoGlob = String(raw.repo || '').trim();
        if (repoGlob) {
          const rg = compileGlob(repoGlob.includes('/') ? repoGlob : repoGlob + '/*');
          if (!repo || !rg.regex.test(repo)) return; // not for this repository
        }
        const c = compileGlob(raw.pattern);
        users.push({ id: 'user:' + i, category: raw.category, scope: c.scope, regex: c.regex, rank: 3, confidence: 'high', order: i, pattern: String(raw.pattern) });
      } catch (e) { errors.push('Custom rule #' + (i + 1) + ' (' + (raw && raw.pattern) + '): ' + e.message); }
    });

    const cache = new Map();

    function evaluate(norm, isDir) {
      if (!norm) return { result: { category: 'prod', confidence: 'high', ruleId: null, reason: 'empty path', ignored: false }, matches: [] };
      const parts = splitPath(norm, isDir);
      const pathForRules = isDir ? norm + '/' : norm;
      const matches = [];

      for (let i = 0; i < users.length; i++) {
        const m = matchRule(users[i], parts, pathForRules);
        if (m != null) {
          matches.push({ ruleId: users[i].id, category: users[i].category, confidence: 'high', scope: users[i].scope, matched: m, user: true });
          return {
            result: { category: users[i].category, confidence: 'high', ruleId: users[i].id, reason: 'custom rule "' + users[i].pattern + '"', ignored: false },
            matches,
          };
        }
      }

      const ignoredResult = (rule) => ({ category: 'prod', confidence: 'high', ruleId: rule.id, reason: 'ignored (' + rule.id + ')', ignored: true });
      for (let i = 0; i < ignores.length; i++) {
        if (!ignores[i].onlyIfProd && ignores[i].regex.test(pathForRules)) return { result: ignoredResult(ignores[i]), matches };
      }
      const ev = evaluateBuiltins(parts, pathForRules, matches);
      if (ev.result.category === 'prod') {
        for (let i = 0; i < ignores.length; i++) {
          if (ignores[i].onlyIfProd && ignores[i].regex.test(pathForRules)) return { result: ignoredResult(ignores[i]), matches };
        }
      }
      return ev;
    }

    function evaluateBuiltins(parts, pathForRules, matches) {

      let best = null, bestMatched = null;
      for (let i = 0; i < builtins.length; i++) {
        const rule = builtins[i];
        const m = matchRule(rule, parts, pathForRules);
        if (m == null) continue;
        matches.push({ ruleId: rule.id, category: rule.category, confidence: rule.confidence, scope: rule.scope, matched: m, user: false });
        if (!best || rule.rank > best.rank || (rule.rank === best.rank && TIE[rule.category] > TIE[best.category])) {
          best = rule; bestMatched = m;
        }
      }
      if (!best) return { result: { category: 'prod', confidence: 'high', ruleId: null, reason: 'no rule matched', ignored: false }, matches };
      if (best.rank < RANK.high) { // explicit production knowledge beats low/medium conventions, never high ones
        for (let i = 0; i < overrides.length; i++) {
          if (overrides[i].regex.test(pathForRules)) {
            return { result: { category: 'prod', confidence: 'medium', ruleId: overrides[i].id, reason: 'override ' + overrides[i].id + ' beats ' + best.confidence + '-confidence ' + best.id, ignored: false }, matches };
          }
        }
      }
      return { result: { category: best.category, confidence: best.confidence, ruleId: best.id, reason: describe(best, bestMatched), ignored: false }, matches };
    }

    function classify(path, o) {
      const isDir = !!(o && o.isDir);
      const norm = normalizePath(path);
      const key = (isDir ? 'd:' : 'f:') + norm;
      const hit = cache.get(key);
      if (hit) return hit;
      const res = evaluate(norm, isDir).result;
      if (cache.size >= MAX_CACHE) cache.clear();
      cache.set(key, res);
      return res;
    }

    function explain(path, o) {
      const isDir = !!(o && o.isDir);
      const norm = normalizePath(path);
      const ev = evaluate(norm, isDir);
      ev.matches.sort((a, b) => (RANK[b.confidence] - RANK[a.confidence]) || (TIE[b.category] - TIE[a.category]));
      return { path: norm, isDir, result: ev.result, matches: ev.matches };
    }

    return {
      classify,
      explain,
      errors,
      ruleCount: builtins.length,
      userRuleCount: users.length,
      clearCache: () => cache.clear(),
    };
  }

  /** Human label for a category (defaults; the settings module may override). */
  const LABELS = { prod: 'PROD', test: 'TEST', support: 'TEST SUPPORT', bench: 'BENCH' };
  const TITLES = { prod: 'Production code', test: 'Test file', support: 'Test support (fixture, mock, snapshot, helper or test config)', bench: 'Benchmark / fuzz target' };

  GHTL.classifier = { CATEGORIES, SCOPES, RANK, LABELS, TITLES, normalizePath, splitPath, compileGlob, translateGlob, createClassifier };
  if (typeof module !== 'undefined' && module.exports) module.exports = GHTL.classifier;
})(typeof globalThis !== 'undefined' ? globalThis : this);
