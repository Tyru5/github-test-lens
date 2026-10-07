'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/content.js');

function entry(path, category, additions, deletions, extra) {
  return Object.assign({ surface: 'diff-legacy', path, category, ignored: false, stats: { additions, deletions } }, extra || {});
}

function treeEntry(path, isDir, surface) {
  return { surface: surface || 'tree-react', path, isDir: !!isDir };
}

function cls(category, ignored) {
  return { category, confidence: 'high', ruleId: category === 'prod' ? null : 'x', reason: 'r', ignored: !!ignored };
}

test('loads in node without a DOM and exports the pure helpers', () => {
  assert.equal(typeof document, 'undefined');
  ['computeStats', 'aggregateDirs', 'indexDirs', 'isCodeFile', 'shortLabel', 'cycleFilter', 'hiddenCount', 'hiddenText', 'collapseSet', 'filterShows']
    .forEach((k) => assert.equal(typeof C[k], 'function', k));
  assert.ok(Array.isArray(C.NON_CODE_EXT));
  assert.deepEqual(C.FILTERS, ['all', 'prod', 'tests']);
  assert.deepEqual(C.COLLAPSE_MODES, ['off', 'test', 'all-tests']);
  assert.equal(globalThis.GHTL.content, C);
});

test('NON_CODE_EXT matches the spec list', () => {
  assert.deepEqual(C.NON_CODE_EXT, ['md', 'mdx', 'markdown', 'rst', 'txt', 'adoc', 'lock', 'json', 'ya?ml', 'toml', 'ini', 'cfg', 'csv',
    'svg', 'png', 'jpe?g', 'gif', 'ico', 'webp', 'woff2?', 'ttf', 'pdf']);
});

test('shortLabel gives one-letter compact labels, prod as fallback', () => {
  assert.equal(C.shortLabel('test'), 'T');
  assert.equal(C.shortLabel('support'), 'S');
  assert.equal(C.shortLabel('bench'), 'B');
  assert.equal(C.shortLabel('prod'), 'P');
  assert.equal(C.shortLabel('nope'), 'P');
});

test('isCodeFile excludes docs, data and assets by extension (case-insensitive)', () => {
  ['src/a.ts', 'lib/x.go', 'Makefile', 'bin/run', 'src/a.min.js', 'docs/readme.md.bak', 'x.c', 'config.yaml.tmpl']
    .forEach((p) => assert.equal(C.isCodeFile(p), true, p));
  ['README.md', 'docs/guide.mdx', 'a.markdown', 'notes.rst', 'notes.txt', 'doc.adoc', 'yarn.lock', 'package.json', 'ci.yml', 'ci.yaml',
    'Cargo.toml', 'setup.ini', 'setup.cfg', 'data.csv', 'logo.svg', 'a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'favicon.ico', 'a.webp',
    'f.woff', 'f.woff2', 'f.ttf', 'paper.pdf', 'README.MD', 'a/b/c.JSON']
    .forEach((p) => assert.equal(C.isCodeFile(p), false, p));
  assert.equal(C.isCodeFile(''), false);
  assert.equal(C.isCodeFile(null), false);
});

test('computeStats fills the buckets, folds bench into support and keeps bench apart', () => {
  const s = C.computeStats([
    entry('src/a.js', 'prod', 10, 2),
    entry('src/b.js', 'prod', 5, 5),
    entry('src/a.test.js', 'test', 20, 1),
    entry('__mocks__/x.js', 'support', 3, 0),
    entry('bench/b.js', 'bench', 4, 1),
  ]);
  assert.deepEqual(s.prod, { files: 2, additions: 15, deletions: 7 });
  assert.deepEqual(s.test, { files: 1, additions: 20, deletions: 1 });
  assert.deepEqual(s.support, { files: 2, additions: 7, deletions: 1 });
  assert.deepEqual(s.bench, { files: 1, additions: 4, deletions: 1 });
  assert.deepEqual(s.ignored, { files: 0, additions: 0, deletions: 0 });
  assert.equal(s.totalFiles, 5);
  assert.equal(s.codeLines, 51);
  assert.equal(s.testShare, Math.round((29 / 51) * 100));
  assert.equal(s.prodCodeFiles, 2);
  assert.equal(s.warning, false);
  assert.equal(s.loaded, 5);
});

test('computeStats is unique by path (first wins); loaded counts unique rendered files', () => {
  const s = C.computeStats([
    entry('src/a.js', 'prod', 10, 0),
    entry('src/a.js', 'prod', 10, 0, { surface: 'diff-react' }),
    entry('src/a.test.js', 'test', 1, 0),
    entry('src/a.test.js', 'test', 999, 0),
  ]);
  assert.equal(s.prod.files, 1);
  assert.equal(s.test.files, 1);
  assert.equal(s.test.additions, 1);
  assert.equal(s.totalFiles, 2);
  assert.equal(s.loaded, 2);
});

test('computeStats excludes ignored files from prod, codeLines and the share', () => {
  const s = C.computeStats([
    entry('src/a.js', 'prod', 10, 0),
    entry('package-lock.json', 'prod', 5000, 4000, { ignored: true }),
    entry('vendor/lib.js', 'prod', 100, 0, { ignored: true }),
    entry('src/a.test.js', 'test', 10, 0),
  ]);
  assert.deepEqual(s.ignored, { files: 2, additions: 5100, deletions: 4000 });
  assert.equal(s.prod.files, 1);
  assert.equal(s.codeLines, 20);
  assert.equal(s.testShare, 50);
  assert.equal(s.totalFiles, 4);
  assert.equal(s.prodCodeFiles, 1);
});

test('computeStats rounds testShare to an integer and uses null when no code lines', () => {
  const share = (t, p) => C.computeStats([entry('t.test.js', 'test', t, 0), entry('p.js', 'prod', p, 0)]).testShare;
  assert.equal(share(1, 2), 33);
  assert.equal(share(2, 1), 67);
  assert.equal(share(1, 7), 13);
  assert.equal(share(0, 9), 0);
  assert.equal(share(9, 0), 100);
  assert.equal(C.computeStats([entry('p.js', 'prod', 0, 0)]).testShare, null);
  assert.equal(C.computeStats([]).testShare, null);
  assert.equal(C.computeStats([entry('x.lock', 'prod', 50, 50, { ignored: true })]).testShare, null);
});

test('computeStats tolerates missing stats and odd input', () => {
  const s = C.computeStats([{ path: 'a.js', category: 'prod' }, { path: 'b.js', category: 'weird', stats: { additions: '3', deletions: -4 } }, null, { category: 'test' }]);
  assert.equal(s.prod.files, 2);
  assert.equal(s.prod.additions, 3);
  assert.equal(s.prod.deletions, 0);
  assert.equal(s.loaded, 2);
  assert.equal(C.computeStats(undefined).loaded, 0);
});

test('warning: production code changed without any test change', () => {
  assert.equal(C.computeStats([entry('src/a.js', 'prod', 10, 0)]).warning, true);
  assert.equal(C.computeStats([entry('src/a.js', 'prod', 10, 0), entry('yarn.lock', 'prod', 500, 0, { ignored: true })]).warning, true);
  assert.equal(C.computeStats([entry('src/a.js', 'prod', 10, 0), entry('README.md', 'prod', 1, 0)]).warning, true);
});

test('warning stays off for docs-only / data-only production changes', () => {
  assert.equal(C.computeStats([entry('README.md', 'prod', 10, 0), entry('docs/x.mdx', 'prod', 1, 1)]).warning, false);
  assert.equal(C.computeStats([entry('package.json', 'prod', 1, 1), entry('ci.yml', 'prod', 2, 0), entry('logo.svg', 'prod', 9, 0)]).warning, false);
  assert.equal(C.computeStats([entry('yarn.lock', 'prod', 500, 0, { ignored: true })]).warning, false);
  assert.equal(C.computeStats([]).warning, false);
});

test('warning stays off when tests, support or benchmarks changed', () => {
  assert.equal(C.computeStats([entry('src/a.js', 'prod', 10, 0), entry('src/a.test.js', 'test', 1, 0)]).warning, false);
  assert.equal(C.computeStats([entry('src/a.js', 'prod', 10, 0), entry('__snapshots__/a.snap', 'support', 0, 3)]).warning, false);
  assert.equal(C.computeStats([entry('src/a.js', 'prod', 10, 0), entry('bench/a.js', 'bench', 2, 0)]).warning, false);
  // renamed test file: zero lines but still a test file
  assert.equal(C.computeStats([entry('src/a.js', 'prod', 10, 0), entry('test/new.test.js', 'test', 0, 0)]).warning, false);
  // test-only change: no prod code at all
  assert.equal(C.computeStats([entry('test/a.test.js', 'test', 3, 0)]).warning, false);
});

test('indexDirs counts files below every ancestor per surface, ignored as prod, duplicates once', () => {
  const entries = [
    treeEntry('src/a/x.test.js'), treeEntry('src/a/x.test.js'), treeEntry('src/a/y.js'), treeEntry('src/b/z.snap'),
    treeEntry('src/a', true), treeEntry('src', true), treeEntry('vendor/lib.js'), treeEntry('src/a/q.js', false, 'tree-legacy'),
  ];
  const results = [cls('test'), cls('test'), cls('prod'), cls('support'), cls('prod'), cls('prod'), cls('prod', true), cls('test')];
  const idx = C.indexDirs(entries, results);
  assert.deepEqual(idx.get('tree-react\nsrc/a'), { files: 2, prod: 1, test: 1, support: 0, bench: 0 });
  assert.deepEqual(idx.get('tree-react\nsrc'), { files: 3, prod: 1, test: 1, support: 1, bench: 0 });
  assert.deepEqual(idx.get('tree-react\nvendor'), { files: 1, prod: 1, test: 0, support: 0, bench: 0 });
  assert.deepEqual(idx.get('tree-legacy\nsrc/a'), { files: 1, prod: 0, test: 1, support: 0, bench: 0 });
  assert.equal(idx.has('tree-react\nsrc/a/x.test.js'), false);
});

test('aggregateDirs: a prod directory whose files are all tests becomes a test directory', () => {
  const entries = [treeEntry('src', true), treeEntry('src/a.test.js'), treeEntry('src/b.spec.js')];
  const results = [cls('prod'), cls('test'), cls('test')];
  const out = C.aggregateDirs(entries, results);
  assert.equal(out[0].category, 'test');
  assert.equal(out[0].ignored, false);
  assert.equal(out[0].aggregated, true);
  assert.match(out[0].reason, /^all 2 files inside are tests$/);
  assert.equal(out[1], results[1]);
  assert.equal(out[2], results[2]);
  assert.equal(results[0].category, 'prod', 'input untouched');
});

test('aggregateDirs: all support → support, all bench → bench, mixed test kinds → test, singular wording', () => {
  const sup = C.aggregateDirs([treeEntry('f', true), treeEntry('f/a.snap'), treeEntry('f/b.snap')], [cls('prod'), cls('support'), cls('support')]);
  assert.equal(sup[0].category, 'support');
  assert.match(sup[0].reason, /test support/);
  const ben = C.aggregateDirs([treeEntry('b', true), treeEntry('b/x.rs')], [cls('prod'), cls('bench')]);
  assert.equal(ben[0].category, 'bench');
  assert.equal(ben[0].reason, 'the only file inside is a benchmark');
  const mix = C.aggregateDirs([treeEntry('m', true), treeEntry('m/a.test.js'), treeEntry('m/a.snap'), treeEntry('m/b.rs')], [cls('prod'), cls('test'), cls('support'), cls('bench')]);
  assert.equal(mix[0].category, 'test');
  const one = C.aggregateDirs([treeEntry('o', true), treeEntry('o/a.test.js')], [cls('prod'), cls('test')]);
  assert.equal(one[0].reason, 'the only file inside is a test');
});

test('aggregateDirs leaves directories alone when any file is prod, none is listed, or it is already classified', () => {
  const mixed = C.aggregateDirs([treeEntry('src', true), treeEntry('src/a.test.js'), treeEntry('src/b.js')], [cls('prod'), cls('test'), cls('prod')]);
  assert.equal(mixed[0].category, 'prod');
  const ignoredChild = C.aggregateDirs([treeEntry('src', true), treeEntry('src/a.test.js'), treeEntry('src/x.min.js')], [cls('prod'), cls('test'), cls('prod', true)]);
  assert.equal(ignoredChild[0].category, 'prod');
  const empty = C.aggregateDirs([treeEntry('src', true)], [cls('prod')]);
  assert.equal(empty[0].category, 'prod');
  const own = C.aggregateDirs([treeEntry('__tests__', true), treeEntry('__tests__/a.js')], [cls('test'), cls('test')]);
  assert.equal(own[0].category, 'test');
  assert.equal(own[0].aggregated, undefined, 'already non-prod: not aggregated');
  const ignoredDir = C.aggregateDirs([treeEntry('vendor', true), treeEntry('vendor/a.test.js')], [cls('prod', true), cls('test')]);
  assert.equal(ignoredDir[0].ignored, true);
  assert.equal(ignoredDir[0].category, 'prod');
});

test('aggregateDirs never mixes surfaces and handles nesting', () => {
  const entries = [treeEntry('src', true), treeEntry('src/a.test.js', false, 'tree-legacy'), treeEntry('src/deep', true), treeEntry('src/deep/b.test.js')];
  const out = C.aggregateDirs(entries, [cls('prod'), cls('test'), cls('prod'), cls('test')]);
  assert.equal(out[0].category, 'test', 'src sees only src/deep/b.test.js on its surface');
  assert.equal(out[2].category, 'test');
  const only = C.aggregateDirs([treeEntry('src', true), treeEntry('src/a.test.js', false, 'tree-legacy')], [cls('prod'), cls('test')]);
  assert.equal(only[0].category, 'prod');
});

test('filterShows and hidden counts', () => {
  assert.equal(C.filterShows('all', 'test'), true);
  assert.equal(C.filterShows('prod', 'prod'), true);
  assert.equal(C.filterShows('prod', 'support'), false);
  assert.equal(C.filterShows('tests', 'prod'), false);
  assert.equal(C.filterShows('tests', 'bench'), true);
  const stats = C.computeStats([
    entry('a.js', 'prod', 1, 0), entry('b.js', 'prod', 1, 0), entry('yarn.lock', 'prod', 1, 0, { ignored: true }),
    entry('a.test.js', 'test', 1, 0), entry('a.snap', 'support', 1, 0), entry('bench/x.js', 'bench', 1, 0),
  ]);
  assert.equal(C.hiddenCount(stats, 'prod'), 3);
  assert.equal(C.hiddenCount(stats, 'tests'), 3);
  assert.equal(C.hiddenCount(stats, 'all'), 0);
  assert.equal(C.hiddenText(stats, 'prod'), '3 test files hidden');
  assert.equal(C.hiddenText(stats, 'tests'), '3 production files hidden');
  assert.equal(C.hiddenText(C.computeStats([entry('a.js', 'prod', 1, 0), entry('t.test.js', 'test', 1, 0)]), 'prod'), '1 test file hidden');
  assert.equal(C.hiddenText(stats, 'all'), '');
  assert.equal(C.hiddenCount(null, 'prod'), 0);
});

test('cycleFilter walks All → Production → Tests and skips filters that would show nothing', () => {
  const both = C.computeStats([entry('a.js', 'prod', 1, 0), entry('a.test.js', 'test', 1, 0)]);
  assert.equal(C.cycleFilter('all', both), 'prod');
  assert.equal(C.cycleFilter('prod', both), 'tests');
  assert.equal(C.cycleFilter('tests', both), 'all');
  const prodOnly = C.computeStats([entry('a.js', 'prod', 1, 0)]);
  assert.equal(C.cycleFilter('all', prodOnly), 'prod');
  assert.equal(C.cycleFilter('prod', prodOnly), 'all');
  const testsOnly = C.computeStats([entry('a.test.js', 'test', 1, 0)]);
  assert.equal(C.cycleFilter('all', testsOnly), 'tests');
  assert.equal(C.cycleFilter('all', null), 'prod');
  assert.equal(C.cycleFilter('bogus', C.computeStats([])), 'prod');
});

test('collapseSet and fmt', () => {
  assert.deepEqual(C.collapseSet('off'), []);
  assert.deepEqual(C.collapseSet('test'), ['test']);
  assert.deepEqual(C.collapseSet('all-tests'), ['test', 'support', 'bench']);
  assert.deepEqual(C.collapseSet('nope'), []);
  assert.equal(C.fmt(1234567), '1,234,567');
  assert.equal(C.fmt(-3), '0');
  assert.equal(C.plural(1, 'file'), 'file');
  assert.equal(C.plural(2, 'file'), 'files');
});

test('computeStats: pending (not yet rendered) files count toward files, measured ones toward lines', () => {
  const stats = C.computeStats([
    { path: 'src/a.ts', category: 'prod', stats: { additions: 10, deletions: 2 } },
    { path: 'test/a.test.ts', category: 'test', stats: { additions: 30, deletions: 0 }, pending: true },
    { path: 'test/b.test.ts', category: 'test', stats: null, pending: true },
    { path: 'src/b.ts', category: 'prod', stats: null, pending: true },
  ]);
  assert.equal(stats.totalFiles, 4);
  assert.equal(stats.loaded, 1);
  assert.equal(stats.pendingFiles, 3);
  assert.equal(stats.unmeasuredFiles, 2);
  assert.equal(stats.test.files, 2);
  assert.equal(stats.test.additions, 30);
  assert.equal(stats.prod.files, 2);
  assert.equal(stats.testShare, 71);
  assert.equal(stats.warning, false);
});
