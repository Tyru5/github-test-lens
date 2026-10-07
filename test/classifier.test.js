'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/classifier.js');

const RULES = [
  { id: 'js.test-suffix', category: 'test', scope: 'basename', regex: '\\.(test|spec)\\.[cm]?[jt]sx?$', flags: 'i', confidence: 'high', description: 'JS/TS test suffix' },
  { id: 'generic.dir.tests', category: 'test', scope: 'segment', regex: '^(test|tests|__tests__)$', flags: 'i', confidence: 'high' },
  { id: 'generic.dir.fixtures', category: 'support', scope: 'segment', regex: '^(fixtures|__fixtures__|__mocks__)$', flags: 'i', confidence: 'high' },
  { id: 'generic.dir.bench', category: 'bench', scope: 'segment', regex: '^(bench|benches|benchmarks?)$', flags: 'i', confidence: 'high' },
  { id: 'generic.dir.spec', category: 'test', scope: 'segment', regex: '^spec$', flags: 'i', confidence: 'low' },
  { id: 'generic.dir.testing', category: 'support', scope: 'segment', regex: '^testing$', flags: 'i', confidence: 'medium' },
  { id: 'go.test', category: 'test', scope: 'basename', regex: '_test\\.go$', confidence: 'high' },
  { id: 'java.src-test', category: 'test', scope: 'path', regex: '(^|/)src/test/', confidence: 'high' },
];
const OVERRIDES = [{ id: 'docs-in-spec', regex: '(^|/)spec/.*\\.(md|txt|ya?ml|json)$', flags: 'i' }];

function make(extra) {
  return C.createClassifier(Object.assign({ rules: RULES, prodOverrides: OVERRIDES }, extra || {}));
}

test('normalizePath handles slashes, bidi marks, renames and dot segments', () => {
  assert.equal(C.normalizePath('C:\\repo\\test\\x.py'), 'C:/repo/test/x.py');
  assert.equal(C.normalizePath('./src//a/./b.js'), 'src/a/b.js');
  assert.equal(C.normalizePath('/root/file.txt/'), 'root/file.txt');
  assert.equal(C.normalizePath('\u200Esrc/node_sqlite.cc\u200E'), 'src/node_sqlite.cc');
  assert.equal(C.normalizePath('lib/old.js \u2192 test/new.js'), 'test/new.js');
  assert.equal(C.normalizePath('lib/old.js => lib/new.js'), 'lib/new.js');
  assert.equal(C.normalizePath('src/{old => __tests__}/x.js'), 'src/__tests__/x.js');
  assert.equal(C.normalizePath(''), '');
  assert.equal(C.normalizePath(null), '');
  assert.equal(C.normalizePath('   '), '');
});

test('splitPath separates directories and basename; directories have no basename', () => {
  assert.deepEqual(C.splitPath('a/b/c.js', false), { segments: ['a', 'b'], basename: 'c.js' });
  assert.deepEqual(C.splitPath('a/b', true), { segments: ['a', 'b'], basename: '' });
  assert.deepEqual(C.splitPath('c.js', false), { segments: [], basename: 'c.js' });
});

test('basename, segment and path scopes classify as expected', () => {
  const c = make();
  assert.equal(c.classify('src/foo.test.ts').category, 'test');
  assert.equal(c.classify('src/foo.spec.tsx').ruleId, 'js.test-suffix');
  assert.equal(c.classify('pkg/x_test.go').category, 'test');
  assert.equal(c.classify('module/src/test/java/Foo.java').category, 'test');
  assert.equal(make({ disabledRuleIds: ['generic.dir.tests'] }).classify('module/src/test/java/Foo.java').ruleId, 'java.src-test');
  assert.equal(c.classify('src/main/java/Foo.java').category, 'prod');
  assert.equal(c.classify('src/contest.js').category, 'prod');
  assert.equal(c.classify('src/latest.ts').category, 'prod');
  assert.equal(c.classify('src/components/Testimonial.tsx').category, 'prod');
  assert.equal(c.classify('').category, 'prod');
});

test('ties at equal confidence prefer support over test, bench over test', () => {
  const c = make();
  const r = c.classify('__tests__/fixtures/a.json');
  assert.equal(r.category, 'support');
  assert.equal(r.ruleId, 'generic.dir.fixtures');
  assert.equal(c.classify('test/benchmarks/x.js').category, 'bench');
});

test('higher confidence beats lower confidence regardless of category', () => {
  const c = make();
  // testing/ is medium support; *.test.ts is high test → test wins
  assert.equal(c.classify('testing/helpers.test.ts').category, 'test');
  // testing/ alone → support (medium)
  assert.equal(c.classify('testing/helpers.ts').category, 'support');
});

test('prod overrides beat low- and medium-confidence matches, never high ones', () => {
  const c = make({ prodOverrides: OVERRIDES.concat([{ id: 'src-main', regex: '(^|/)src/main/' }]) });
  assert.equal(c.classify('spec/intro.md').category, 'prod');
  assert.equal(c.classify('spec/intro.md').ruleId, 'docs-in-spec');
  assert.equal(c.classify('spec/foo_spec.rb').category, 'test');
  // medium-confidence testing/ dir yields to the explicit src/main override
  assert.equal(c.classify('src/main/java/testing/Helper.java').category, 'prod');
  assert.equal(c.classify('src/main/java/testing/Helper.java').ruleId, 'src-main');
  // high-confidence rules are never overridden
  assert.equal(c.classify('__tests__/README.md').category, 'test');
  assert.equal(c.classify('src/main/java/FooTest.test.ts').category, 'test');
});

test('directory entries are classified by their own name', () => {
  const c = make();
  assert.equal(c.classify('src/test', { isDir: true }).category, 'test');
  assert.equal(c.classify('src', { isDir: true }).category, 'prod');
  assert.equal(c.classify('benches', { isDir: true }).category, 'bench');
  // basename rules never apply to directories
  assert.equal(c.classify('foo.test.ts', { isDir: true }).category, 'prod');
  // path rules see a trailing slash for directories
  assert.equal(make({ disabledRuleIds: ['generic.dir.tests'] }).classify('app/src/test', { isDir: true }).ruleId, 'java.src-test');
});

test('memoization does not leak between file and directory lookups', () => {
  const c = make();
  assert.equal(c.classify('foo.test.ts').category, 'test');
  assert.equal(c.classify('foo.test.ts', { isDir: true }).category, 'prod');
  assert.equal(c.classify('foo.test.ts').category, 'test');
});

test('user rules run first, in order, and may force prod', () => {
  const c = make({ userRules: [
    { pattern: 'src/**/*.integration.ts', category: 'test', enabled: true },
    { pattern: '*.test.ts', category: 'prod', enabled: true },
    { pattern: 'disabled/**', category: 'test', enabled: false },
  ] });
  assert.equal(c.classify('src/a/b/c.integration.ts').ruleId, 'user:0');
  assert.equal(c.classify('src/x.test.ts').category, 'prod');
  assert.equal(c.classify('disabled/x.js').category, 'prod');
  assert.equal(c.classify('disabled/x.js').ruleId, null);
  assert.equal(c.userRuleCount, 2);
});

test('repo-scoped user rules apply only to matching repositories', () => {
  const rules = [{ pattern: 'contract/**', category: 'test', repo: 'acme/*', enabled: true }];
  assert.equal(make({ userRules: rules, repo: 'acme/widgets' }).classify('contract/x.ts').category, 'test');
  assert.equal(make({ userRules: rules, repo: 'other/widgets' }).classify('contract/x.ts').category, 'prod');
  assert.equal(make({ userRules: rules }).classify('contract/x.ts').category, 'prod');
  const exact = [{ pattern: 'contract/**', category: 'test', repo: 'acme/widgets', enabled: true }];
  assert.equal(make({ userRules: exact, repo: 'acme/widgets' }).classify('contract/x.ts').category, 'test');
  assert.equal(make({ userRules: exact, repo: 'acme/widgets2' }).classify('contract/x.ts').category, 'prod');
});

test('invalid user rules are reported, not fatal', () => {
  const c = make({ userRules: [{ pattern: '/(unclosed/', category: 'test', enabled: true }, { pattern: 'x', category: 'nope', enabled: true }] });
  assert.equal(c.errors.length, 2);
  assert.equal(c.classify('src/foo.test.ts').category, 'test');
});

test('disabledRuleIds switch built-ins off', () => {
  const c = make({ disabledRuleIds: ['generic.dir.tests'] });
  assert.equal(c.classify('test/x.js').category, 'prod');
  assert.equal(c.classify('test/x.test.js').category, 'test');
});

test('compileGlob: gitignore-like semantics', () => {
  const g1 = C.compileGlob('*.spec.ts');
  assert.equal(g1.scope, 'name');
  assert.ok(g1.regex.test('a.spec.ts'));
  assert.ok(!g1.regex.test('a/b.spec.ts'));
  const g2 = C.compileGlob('src/**/__tests__/**');
  assert.equal(g2.scope, 'path');
  assert.ok(g2.regex.test('src/__tests__/x.js'));
  assert.ok(g2.regex.test('src/a/b/__tests__/x/y.js'));
  assert.ok(!g2.regex.test('lib/__tests__/x.js'));
  const g3 = C.compileGlob('{test,tests}/**');
  assert.ok(g3.regex.test('tests/a.js'));
  assert.ok(!g3.regex.test('testing/a.js'));
  const g4 = C.compileGlob('e2e/');
  assert.ok(g4.regex.test('e2e/login.cy.ts'));
  const g5 = C.compileGlob('/\\.int\\.test\\.ts$/');
  assert.equal(g5.kind, 'regex');
  assert.ok(g5.regex.test('src/a.int.test.ts'));
  const g6 = C.compileGlob('file?.js');
  assert.ok(g6.regex.test('file1.js'));
  assert.ok(!g6.regex.test('file12.js'));
  const g7 = C.compileGlob('*.{snap,golden}');
  assert.ok(g7.regex.test('a.snap'));
  assert.ok(g7.regex.test('b.golden'));
  assert.ok(!g7.regex.test('c.json'));
  const g8 = C.compileGlob('src/[abc]*.js');
  assert.ok(g8.regex.test('src/alpha.js'));
  assert.ok(!g8.regex.test('src/delta.js'));
  assert.throws(() => C.compileGlob(''), /empty/);
  assert.throws(() => C.compileGlob('/(/'), /Invalid regex/);
  assert.throws(() => C.compileGlob('/'), /empty/);
});

test('name-scoped user globs match directory names too', () => {
  const c = make({ userRules: [{ pattern: '__e2e__', category: 'test', enabled: true }] });
  assert.equal(c.classify('src/__e2e__/login.ts').category, 'test');
  assert.equal(c.classify('src/__e2e__', { isDir: true }).category, 'test');
});

test('explain lists every matching rule, best first', () => {
  const c = make();
  const ex = c.explain('__tests__/fixtures/a.json');
  assert.equal(ex.result.category, 'support');
  assert.deepEqual(ex.matches.map((m) => m.ruleId), ['generic.dir.fixtures', 'generic.dir.tests']);
  assert.equal(c.explain('src/x.js').matches.length, 0);
});

test('regex sources with g/y flags cannot poison lastIndex', () => {
  const c = C.createClassifier({ rules: [{ id: 'g', category: 'test', scope: 'basename', regex: '\\.test\\.js$', flags: 'g', confidence: 'high' }] });
  assert.equal(c.classify('a.test.js').category, 'test');
  assert.equal(c.classify('b.test.js').category, 'test');
  assert.equal(c.classify('c.test.js').category, 'test');
});

test('throughput: 20k classifications stay fast', () => {
  const c = make();
  const t0 = Date.now();
  for (let i = 0; i < 20000; i++) c.classify('src/dir' + (i % 500) + '/file' + i + (i % 3 ? '.test.ts' : '.ts'));
  assert.ok(Date.now() - t0 < 2000);
});

test('ignore rules mark lockfiles/generated code as prod + ignored, after user rules', () => {
  const c = C.createClassifier({ rules: RULES, ignoreRules: [
    { id: 'lockfiles', regex: '(^|/)(package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|Cargo\\.lock)$' },
    { id: 'vendored', regex: '(^|/)(node_modules|vendor)/' },
  ], userRules: [{ pattern: 'vendor/mine/**', category: 'test', enabled: true }] });
  const r = c.classify('package-lock.json');
  assert.equal(r.category, 'prod');
  assert.equal(r.ignored, true);
  assert.equal(c.classify('vendor/lib/x_test.go').ignored, true);
  assert.equal(c.classify('vendor/lib/x_test.go').category, 'prod');
  assert.equal(c.classify('vendor/mine/x.js').category, 'test');
  assert.equal(c.classify('src/x.test.ts').ignored, false);
  assert.equal(c.classify('src/x.ts').ignored, false);
});

test('onlyIfProd ignore rules yield to test classifications; plain ignores do not', () => {
  const c = C.createClassifier({ rules: RULES, ignoreRules: [
    { id: 'vendored', regex: '(^|/)(node_modules|vendor)/' },
    { id: 'generated', regex: '\\.(min\\.js|map)$', onlyIfProd: true },
  ] });
  assert.deepEqual([c.classify('test/fixtures/a.map').category, c.classify('test/fixtures/a.map').ignored], ['support', false]);
  assert.deepEqual([c.classify('src/bundle.min.js').category, c.classify('src/bundle.min.js').ignored], ['prod', true]);
  assert.deepEqual([c.classify('vendor/x_test.go').category, c.classify('vendor/x_test.go').ignored], ['prod', true]);
  assert.equal(c.classify('src/app.js').ignored, false);
});

test('compileGlob keeps gitignore-style "/dir/" patterns as anchored globs', () => {
  const g = C.compileGlob('/build/');
  assert.equal(g.kind, 'glob');
  assert.ok(g.regex.test('build/x.js'));
  assert.ok(!g.regex.test('src/build/x.js'));
  assert.equal(C.compileGlob('/^build\\//').kind, 'regex');
  assert.equal(C.compileGlob('/build/i').kind, 'regex');
});
