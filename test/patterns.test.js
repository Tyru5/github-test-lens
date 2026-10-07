'use strict';
/* GitHub Test Lens — built-in catalog tests (SPEC §13).
 * Every rule must have a valid shape and compile, its own `matches` / `nonMatches` examples must hold
 * (alone and inside the full catalog), overrides and ignore rules must compile, and a table of
 * real-world paths pins the behaviour of the full catalog across ecosystems. */
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/patterns.js');
const C = require('../src/classifier.js');

const RULE_CATEGORIES = C.CATEGORIES.filter((c) => c !== 'prod'); // built-ins never force prod
const CONFIDENCES = Object.keys(C.RANK);
const FLAGS_RE = /^[imsu]*$/; // no g/y: a sticky lastIndex would make matching stateful

function fullClassifier(extra) {
  return C.createClassifier(Object.assign({ rules: P.rules, prodOverrides: P.prodOverrides, ignoreRules: P.ignore }, extra || {}));
}

function soloClassifier(rule) {
  return C.createClassifier({ rules: [rule] });
}

function brief(r) {
  return r.category + ' via ' + (r.ruleId || 'no rule') + (r.ignored ? ' (ignored)' : '');
}

function isStringList(v) {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.trim().length > 0);
}

const FULL = fullClassifier();

test('catalog: version, non-empty lists, unique ids across rules, overrides and ignore', () => {
  assert.ok(Number.isInteger(P.version) && P.version >= 1, 'version must be a positive integer');
  assert.ok(Array.isArray(P.rules) && P.rules.length > 0, 'rules must be a non-empty array');
  assert.ok(Array.isArray(P.prodOverrides) && P.prodOverrides.length > 0, 'prodOverrides must be a non-empty array');
  assert.ok(Array.isArray(P.ignore) && P.ignore.length > 0, 'ignore must be a non-empty array');
  const seen = new Map();
  for (const [list, entries] of [['rules', P.rules], ['prodOverrides', P.prodOverrides], ['ignore', P.ignore]]) {
    for (const e of entries) {
      assert.ok(typeof e.id === 'string' && /^\S+$/.test(e.id), list + ': id must be a non-blank string, got ' + JSON.stringify(e.id));
      assert.ok(!seen.has(e.id), 'duplicate id "' + e.id + '" in ' + list + ' (first seen in ' + seen.get(e.id) + ')');
      seen.set(e.id, list);
    }
  }
});

test('catalog: the full catalog compiles with no errors', () => {
  assert.deepEqual(FULL.errors, []);
  assert.equal(FULL.ruleCount, P.rules.length);
});

for (const rule of P.rules) {
  test('rule ' + rule.id + ': shape, compiles, matches and nonMatches hold', () => {
    assert.ok(RULE_CATEGORIES.includes(rule.category), 'category: ' + rule.category);
    assert.ok(C.SCOPES.includes(rule.scope), 'scope: ' + rule.scope);
    assert.ok(CONFIDENCES.includes(rule.confidence), 'confidence: ' + rule.confidence);
    assert.ok(typeof rule.regex === 'string' && rule.regex.length > 0, 'regex must be a non-empty string');
    assert.ok(typeof rule.flags === 'string' && FLAGS_RE.test(rule.flags), 'flags: ' + JSON.stringify(rule.flags));
    assert.ok(typeof rule.description === 'string' && rule.description.length > 0, 'description required');
    assert.ok(isStringList(rule.ecosystems), 'ecosystems must be a non-empty list of strings');
    assert.ok(isStringList(rule.matches), 'matches must be a non-empty list of paths');
    assert.ok(isStringList(rule.nonMatches), 'nonMatches must be a non-empty list of paths');
    assert.doesNotThrow(() => new RegExp(rule.regex, rule.flags));

    const solo = soloClassifier(rule);
    assert.deepEqual(solo.errors, []);
    assert.equal(solo.ruleCount, 1);

    const failures = [];
    for (const path of rule.matches) {
      const alone = solo.classify(path);
      if (alone.category !== rule.category || alone.ruleId !== rule.id) {
        failures.push('matches ' + JSON.stringify(path) + ': alone -> ' + brief(alone) + ', wanted ' + rule.category);
      }
      const full = FULL.classify(path);
      if (full.category === 'prod' || full.ignored) {
        failures.push('matches ' + JSON.stringify(path) + ': full catalog -> ' + brief(full) + ', wanted non-prod');
      }
    }
    for (const path of rule.nonMatches) {
      const alone = solo.classify(path);
      if (alone.category !== 'prod' || alone.ruleId !== null) {
        failures.push('nonMatches ' + JSON.stringify(path) + ': alone -> ' + brief(alone) + ', wanted prod');
      }
    }
    assert.deepEqual(failures, []);
  });
}

test('prodOverrides and ignore entries compile', () => {
  for (const [list, entries] of [['prodOverrides', P.prodOverrides], ['ignore', P.ignore]]) {
    for (const e of entries) {
      assert.ok(typeof e.regex === 'string' && e.regex.length > 0, list + ' ' + e.id + ': regex must be a non-empty string');
      assert.ok(typeof e.flags === 'string' && FLAGS_RE.test(e.flags), list + ' ' + e.id + ': flags ' + JSON.stringify(e.flags));
      assert.ok(typeof e.description === 'string' && e.description.length > 0, list + ' ' + e.id + ': description required');
      assert.doesNotThrow(() => new RegExp(e.regex, e.flags), list + ' ' + e.id + ' must compile');
    }
  }
  const c = C.createClassifier({ prodOverrides: P.prodOverrides, ignoreRules: P.ignore });
  assert.deepEqual(c.errors, []);
  assert.equal(c.ruleCount, 0);
});

// [path, expected category, { ruleId?, ignored?, isDir? }] — every row was verified against the current catalog.
// ruleId is pinned only where the mechanism (override, ignore) is the point of the row.
const REAL_WORLD = [
  // review regressions (source dirs named build/, telemetry/, common.rs, Double.cs, KMP, api-spec)
  ['src/go/build/build_test.go', 'test'],
  ['packages/next/src/build/index.ts', 'prod', { ignored: false }],
  ['src/telemetry/index.ts', 'prod'],
  ['src/common.rs', 'prod'],
  ['src/System/Double.cs', 'prod'],
  ['src/main/scala/com/acme/HealthCheck.scala', 'prod'],
  ['shared/src/commonMain/kotlin/com/acme/LoginFeature.kt', 'prod'],
  ['api-specs/openapi.yaml', 'prod'],
  ['src/testHelpers/render.tsx', 'support'],

  // JavaScript / TypeScript
  ['src/components/Button.test.tsx', 'test'],
  ['src/__tests__/utils.js', 'test'],
  ['cypress/e2e/login.cy.ts', 'test'],
  ['e2e/checkout.spec.ts', 'test'],
  ['src/__mocks__/fs.js', 'support'],
  ['src/__snapshots__/Button.test.tsx.snap', 'support'],
  ['jest.config.js', 'support'],
  ['vitest.config.ts', 'support'],
  ['playwright.config.ts', 'support'],
  ['src/setupTests.ts', 'support'],
  ['src/test-utils.tsx', 'support'],
  ['src/testing/helpers.ts', 'support'],
  ['src/Button.stories.tsx', 'prod'], // Storybook stories are development artifacts, not tests
  ['src/test.ts', 'test'], // bare test.ts entry (jest/AVA/karma), medium
  ['src/index.ts', 'prod'],
  ['src/contest.js', 'prod'],
  ['src/latest.ts', 'prod'],
  ['src/components/Testimonial.tsx', 'prod'],
  ['src/integrations/testrail/client.ts', 'prod'],
  ['src/testing-library/x.ts', 'support'], // testing-library/ wrappers are test utilities
  ['package-lock.json', 'prod', { ruleId: 'ignore.lockfiles', ignored: true }],
  ['yarn.lock', 'prod', { ruleId: 'ignore.lockfiles', ignored: true }],
  ['pnpm-lock.yaml', 'prod', { ruleId: 'ignore.lockfiles', ignored: true }],
  ['dist/bundle.min.js', 'prod', { ruleId: 'ignore.dist', ignored: true }],
  ['node_modules/foo/index.test.js', 'prod', { ruleId: 'ignore.vendored', ignored: true }], // ignore beats a test rule
  ['coverage/lcov.info', 'prod', { ruleId: 'ignore.vendored', ignored: true }],
  ['src/app.js.map', 'prod', { ruleId: 'ignore.generated', ignored: true }],
  ['app/proto/foo_pb2.py', 'prod', { ruleId: 'ignore.generated', ignored: true }],
  ['app/proto/foo_pb2_grpc.py', 'prod', { ruleId: 'ignore.generated', ignored: true }],
  ['app/proto/foo_pb2.pyi', 'prod', { ruleId: 'ignore.generated', ignored: true }],
  ['src/pb2.py', 'prod', { ruleId: null, ignored: false }],
  // Python
  ['tests/test_api.py', 'test'],
  ['tests/conftest.py', 'support'], // high test dir vs high support file: support wins the tie
  ['pytest.ini', 'support'],
  ['tox.ini', 'support'],
  ['app/models.py', 'prod'],
  ['src/pkg/protest.py', 'prod'],
  // Go
  ['pkg/server/server_test.go', 'test'],
  ['examples/foo_test.go', 'test'], // override.examples only beats low-confidence matches; go.test is high
  ['pkg/server/testdata/req.json', 'support'],
  ['internal/mocks/mock_store.go', 'support'],
  ['pkg/x_bench.go', 'prod'], // Go benchmarks live in *_test.go; _bench.go is not a convention
  ['cmd/app/main.go', 'prod'],
  ['go.sum', 'prod', { ruleId: 'ignore.lockfiles', ignored: true }],
  ['api/v1/api.pb.go', 'prod', { ruleId: 'ignore.generated', ignored: true }],
  ['vendor/github.com/x/y_test.go', 'prod', { ruleId: 'ignore.vendored', ignored: true }],
  // JVM
  ['src/test/java/com/acme/FooTest.java', 'test'],
  ['app/src/androidTest/java/com/acme/FlowTest.kt', 'test'],
  ['lib/src/testFixtures/java/Fx.java', 'support'],
  ['src/main/java/com/acme/Foo.java', 'prod'],
  ['src/main/java/com/acme/Contest.java', 'prod'],
  // .NET
  ['src/App.Tests/FooTests.cs', 'test'],
  ['src/App/Services/Testimonial.cs', 'prod'],
  ['src/App.Testing/X.cs', 'prod'],
  ['src/App/Foo.g.cs', 'prod', { ruleId: 'ignore.generated', ignored: true }],
  // Ruby
  ['spec/models/user_spec.rb', 'test'],
  ['spec/spec_helper.rb', 'support'],
  ['spec/support/factories/users.rb', 'support'],
  ['test/test_helper.rb', 'support'],
  ['.rspec', 'support'],
  ['app/models/user.rb', 'prod'],
  ['Gemfile.lock', 'prod', { ruleId: 'ignore.lockfiles', ignored: true }],
  // PHP
  ['tests/Unit/UserTest.php', 'test'],
  ['phpunit.xml.dist', 'support'],
  ['src/Controller/Contest.php', 'prod'],
  // Rust
  ['src/parser/tests.rs', 'test'],
  ['benches/parse.rs', 'bench'],
  ['fuzz/fuzz_targets/parse.rs', 'bench'],
  ['src/snapshots/parser__parse.snap', 'support'],
  ['proptest-regressions/a.txt', 'support'],
  ['src/lib.rs', 'prod'],
  ['Cargo.lock', 'prod', { ruleId: 'ignore.lockfiles', ignored: true }],
  // Swift / Objective-C
  ['Tests/AppTests/FooTests.swift', 'test'],
  ['AppUITests/Flow.swift', 'test'],
  ['Sources/App/Foo.swift', 'prod'],
  // Dart / Flutter
  ['test/widget_test.dart', 'test'],
  ['integration_test/app_test.dart', 'test'],
  ['lib/main.dart', 'prod'],
  ['lib/models/user.freezed.dart', 'prod', { ruleId: 'ignore.generated', ignored: true }],
  ['lib/models/user.g.dart', 'prod', { ruleId: 'ignore.generated', ignored: true }],
  // Elixir / Erlang
  ['test/my_app/accounts_test.exs', 'test'],
  ['test/app_SUITE.erl', 'test'],
  ['test/test_helper.exs', 'support'],
  ['lib/my_app/accounts.ex', 'prod'],
  ['mix.lock', 'prod', { ruleId: 'ignore.lockfiles', ignored: true }],
  // C / C++
  ['base/strings/string_util_unittest.cc', 'test'],
  ['src/parse_benchmark.cc', 'bench'],
  ['src/url_fuzzer.cc', 'bench'],
  ['src/attest.cc', 'prod'],
  ['third_party/zlib/inflate.c', 'prod', { ruleId: 'ignore.vendored', ignored: true }],
  // Other ecosystems
  ['t/01-basic.t', 'test'],
  ['tests/testthat/test-parse.R', 'test'],
  ['test/runtests.jl', 'test'],
  ['spec/parser_spec.lua', 'test'],
  ['test/cli.bats', 'test'],
  ['tests/main.tftest.hcl', 'test'],
  ['test/Counter.t.sol', 'test'],
  ['src/Counter.sol', 'prod'],
  ['features/login.feature', 'test'],
  ['features/step_definitions/login.js', 'support'],
  ['rtl/alu_tb.sv', 'test'],
  ['src/parser_test.zig', 'test'],
  ['spec/parser_spec.cr', 'test'],
  // Specification documents and example code: prod overrides beat only low-confidence matches
  ['docs/spec/intro.md', 'prod', { ruleId: 'override.docs-in-spec' }],
  ['spec/openapi.yaml', 'prod', { ruleId: 'override.spec-data-files' }],
  ['spec/foo_spec.rb', 'test'], // high-confidence ruby.test-file is not overridden
  ['examples/Button.stories.tsx', 'prod'],
  ['samples/spec/x.rb', 'test'], // spec/*.rb is a high-confidence RSpec convention even inside samples/
  // Repository housekeeping files
  ['README.md', 'prod'],
  ['Makefile', 'prod'],
  ['Dockerfile', 'prod'],
  ['.github/workflows/ci.yml', 'prod'],
  // Rename display strings as GitHub renders them: the new path decides
  ['src/{old => __tests__}/x.js', 'test'],
  ['lib/old.js \u2192 test/new.js', 'test'],
  ['lib/old.js => lib/new.js', 'prod'],
  // Directory entries (file-tree rows)
  ['__tests__', 'test', { isDir: true }],
  ['src/test', 'test', { isDir: true }],
  ['testdata', 'support', { isDir: true }],
  ['src/__mocks__', 'support', { isDir: true }],
  ['benches', 'bench', { isDir: true }],
  ['node_modules', 'prod', { ruleId: 'ignore.vendored', ignored: true, isDir: true }],
  ['src', 'prod', { isDir: true }],
  ['src/examples', 'prod', { isDir: true }],
];

test('real-world paths classify as expected with the full catalog', () => {
  const failures = [];
  for (const [path, category, opts] of REAL_WORLD) {
    const o = opts || {};
    const r = FULL.classify(path, { isDir: !!o.isDir });
    const wantIgnored = !!o.ignored;
    const ok = r.category === category && r.ignored === wantIgnored && (o.ruleId === undefined || r.ruleId === o.ruleId);
    if (!ok) {
      failures.push(JSON.stringify(path) + (o.isDir ? ' (dir)' : '') + ': got ' + brief(r) + ', wanted ' + category +
        (wantIgnored ? ' (ignored)' : '') + (o.ruleId ? ' via ' + o.ruleId : ''));
    }
  }
  assert.deepEqual(failures, []);
});

test('explain lists every catalog rule that matched, best first', () => {
  const ex = FULL.explain('test/fixtures/a.test.js');
  assert.equal(ex.result.category, 'support');
  assert.equal(ex.matches[0].category, 'support');
  assert.ok(ex.matches.some((m) => m.category === 'test'));
  assert.ok(ex.matches.length >= 3);
  assert.equal(FULL.explain('src/index.ts').matches.length, 0);
});

test('disabledRuleIds switch a catalog rule off without touching the rest', () => {
  const c = fullClassifier({ disabledRuleIds: ['generic.dir.tests'] });
  assert.equal(c.ruleCount, P.rules.length - 1);
  assert.equal(c.classify('test/x.js').category, 'prod');
  assert.equal(c.classify('test/x.test.js').category, 'test');
});

test('throughput: 20k distinct paths through the full catalog stay fast', () => {
  const c = fullClassifier();
  const t0 = Date.now();
  for (let i = 0; i < 20000; i++) c.classify('pkg/dir' + (i % 500) + '/file' + i + (i % 3 ? '_test.go' : '.go'));
  assert.ok(Date.now() - t0 < 2000);
});
