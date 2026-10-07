'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/pr-totals.js');
const C = require('../src/classifier.js');
const P = require('../src/patterns.js');

const classifier = C.createClassifier({ rules: P.rules, prodOverrides: P.prodOverrides, ignoreRules: P.ignore });
const classify = (p) => classifier.classify(p);

test('prFromPath recognises every PR tab', () => {
  assert.deepEqual(T.prFromPath('/Acme/Studio/pull/1968'), { owner: 'Acme', repo: 'Studio', number: '1968', key: 'acme/studio#1968' });
  assert.equal(T.prFromPath('/a/b/pull/1968/files').number, '1968');
  assert.equal(T.prFromPath('/a/b/pull/1968/changes/abc123').number, '1968');
  assert.equal(T.prFromPath('/a/b/pulls'), null);
  assert.equal(T.prFromPath('/a/b/issues/3'), null);
});

test('parseChangeText reads legacy file header counts', () => {
  assert.deepEqual(T.parseChangeText('96 changes: 69 additions & 27 deletions'), { additions: 69, deletions: 27 });
  assert.deepEqual(T.parseChangeText('2 changes: 1 addition & 1 deletion'), { additions: 1, deletions: 1 });
  assert.deepEqual(T.parseChangeText('1,234 changes: 1,200 additions & 34 deletions'), { additions: 1200, deletions: 34 });
  assert.equal(T.parseChangeText('Binary file not shown'), null);
});

test('split separates test, support and bench lines; ignored lockfiles stay in', () => {
  const parts = T.split([
    { path: 'src/app.ts', additions: 100, deletions: 20 },
    { path: 'src/app.test.ts', additions: 50, deletions: 5 },
    { path: 'test/fixtures/a.json', additions: 10, deletions: 0 },
    { path: 'benches/parse.rs', additions: 4, deletions: 1 },
    { path: 'package-lock.json', additions: 300, deletions: 200 },
    { path: 'src/app.ts', additions: 999, deletions: 999 }, // duplicate path counts once
  ], classify);
  assert.deepEqual(parts.tests, { files: 3, additions: 64, deletions: 6 });
  assert.deepEqual(parts.all, { files: 5, additions: 464, deletions: 226 });
});

test('withoutTests subtracts from GitHub totals and flags partial file lists', () => {
  const parts = T.split([{ path: 'src/a.ts', additions: 10, deletions: 2 }, { path: 'src/a.test.ts', additions: 30, deletions: 1 }], classify);
  const exact = T.withoutTests({ additions: 40, deletions: 3 }, parts);
  assert.deepEqual([exact.additions, exact.deletions, exact.exact, exact.testFiles], [10, 2, true, 1]);
  const partial = T.withoutTests({ additions: 706, deletions: 199 }, parts);
  assert.deepEqual([partial.additions, partial.deletions, partial.exact], [676, 198, false]);
});

test('squares mirror GitHub: one per line up to five, split by ratio', () => {
  assert.deepEqual(T.squares(0, 0), { add: 0, del: 0, neutral: 5 });
  assert.deepEqual(T.squares(2, 0), { add: 2, del: 0, neutral: 3 });
  assert.deepEqual(T.squares(706, 199), { add: 4, del: 1, neutral: 0 });
  assert.deepEqual(T.squares(1000, 1), { add: 4, del: 1, neutral: 0 });
  assert.deepEqual(T.squares(1, 1000), { add: 1, del: 4, neutral: 0 });
  assert.deepEqual(T.squares(0, 9), { add: 0, del: 5, neutral: 0 });
});
