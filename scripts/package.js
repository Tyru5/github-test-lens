#!/usr/bin/env node
// Builds the Chrome Web Store upload: dist/github-test-lens-<version>.zip
// Contains only what the extension needs at runtime (manifest.json, src/, icons/), validates the
// manifest against the store's hard limits and checks every file it references exists.
// Usage: node scripts/package.js        (requires the `zip` CLI)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const INCLUDE = ['manifest.json', 'src', 'icons'];

function fail(msg) {
  console.error('package: ' + msg);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

// --- manifest checks (Chrome Web Store limits) ---------------------------------------------------
if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version) || manifest.version.split('.').some((p) => p.length > 1 && p[0] === '0' || Number(p) > 65535)) fail('invalid version ' + manifest.version);
if (!manifest.name || manifest.name.length > 75) fail('name must be 1-75 characters');
if (!manifest.description || manifest.description.length > 132) fail('description must be 1-132 characters (is ' + (manifest.description || '').length + ')');
if (manifest.short_name && manifest.short_name.length > 12) fail('short_name must be at most 12 characters');
if (!manifest.icons || !manifest.icons['128']) fail('a 128px icon is required');
for (const key of ['browser_action', 'page_action', 'author']) if (manifest[key]) fail('remove the "' + key + '" key');
if (manifest.background && (manifest.background.scripts || manifest.background.page || manifest.background.persistent !== undefined)) fail('MV3 background must be a service_worker only');

// --- referenced files exist -------------------------------------------------------------------------
const referenced = new Set();
Object.values(manifest.icons || {}).forEach((p) => referenced.add(p));
const action = manifest.action || {};
if (action.default_popup) referenced.add(action.default_popup);
Object.values(action.default_icon || {}).forEach((p) => referenced.add(p));
if (manifest.background && manifest.background.service_worker) referenced.add(manifest.background.service_worker);
if (manifest.options_ui && manifest.options_ui.page) referenced.add(manifest.options_ui.page);
(manifest.content_scripts || []).forEach((cs) => (cs.js || []).concat(cs.css || []).forEach((p) => referenced.add(p)));
for (const p of referenced) if (!fs.existsSync(path.join(ROOT, p))) fail('manifest references a missing file: ' + p);

// Every script/stylesheet an extension page loads must ship too.
for (const page of [action.default_popup, manifest.options_ui && manifest.options_ui.page].filter(Boolean)) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) fail(page + ' has an inline <script> (blocked by the MV3 CSP)');
  if (/\son[a-z]+\s*=/i.test(html)) fail(page + ' has an inline event handler (blocked by the MV3 CSP)');
  for (const m of html.matchAll(/\b(?:src|href)="([^"#:]+)"/g)) {
    const target = path.join(ROOT, path.dirname(page), m[1]);
    if (!fs.existsSync(target)) fail(page + ' references a missing file: ' + m[1]);
  }
}

// Service worker importScripts() targets.
const swPath = manifest.background && manifest.background.service_worker;
if (swPath) {
  const sw = fs.readFileSync(path.join(ROOT, swPath), 'utf8');
  for (const m of sw.matchAll(/importScripts\(\s*'([^']+)'\s*\)/g)) {
    if (!fs.existsSync(path.join(ROOT, path.dirname(swPath), m[1]))) fail(swPath + ' imports a missing file: ' + m[1]);
  }
}

// No remotely hosted code in shipped JavaScript.
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}
for (const file of walk(path.join(ROOT, 'src'))) {
  if (!/\.(js|html)$/.test(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (/\beval\s*\(|new\s+Function\s*\(/.test(text)) fail(path.relative(ROOT, file) + ' uses eval/new Function');
  if (/<script[^>]+src="https?:/i.test(text) || /importScripts\(\s*'https?:/.test(text)) fail(path.relative(ROOT, file) + ' loads remote code');
}

// --- build ----------------------------------------------------------------------------------------------
fs.mkdirSync(DIST, { recursive: true });
const out = path.join(DIST, 'github-test-lens-' + manifest.version + '.zip');
if (fs.existsSync(out)) fs.unlinkSync(out);
execFileSync('zip', ['-r', '-X', '-q', out].concat(INCLUDE, ['-x', '*.DS_Store']), { cwd: ROOT, stdio: 'inherit' });
const size = fs.statSync(out).size;
const listing = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).trim().split('\n');
console.log('built ' + path.relative(ROOT, out) + ' (' + (size / 1024).toFixed(1) + ' KB, ' + listing.length + ' entries)');
listing.forEach((f) => console.log('  ' + f));
