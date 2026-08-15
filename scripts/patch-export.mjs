#!/usr/bin/env node
/**
 * scripts/patch-export.mjs
 *
 * Patches a Framer static export in-place:
 *   (a) canonical / og:url rewrite  — SKIPPED until SITE_HOST is set
 *   (b) <title> replacement          — per-route values from TITLE_MAP
 *   (c) Framer badge removal         — element, injecting <script>, CSS rules
 *
 * Usage:
 *   node scripts/patch-export.mjs <path-to-export-folder>
 *   node scripts/patch-export.mjs .
 *
 * Guarantees:
 *   - Never writes outside the resolved target folder.
 *   - Skips node_modules/, scripts/, .git/ during the tree walk.
 *   - Warns (does not throw) when expected content is absent.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname, resolve, normalize } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// (a) TODO: set to your production origin to enable canonical / og:url rewriting.
//     Example: "https://axiom.ai"
//     While null, <link rel="canonical"> and <meta property="og:url"> are left
//     completely untouched.
const SITE_HOST = null;
// ─────────────────────────────────────────────────────────────────────────────

// (b) Per-route <title> values. Key is the URL path; "/" is the root index.html.
const TITLE_MAP = {
  '/':                     'Axiom \u2014 The agent that works where you work',
  '/about':                'Manifesto \u2014 Axiom',
  '/faq':                  'Questions \u2014 Axiom',
  '/how-it-works':         'Install Axiom in two minutes',
  '/privacy-policy':       'Privacy Policy \u2014 Axiom',
  '/terms-and-conditions': 'Terms & Conditions \u2014 Axiom',
  '/acceptable-use':       'Acceptable Use \u2014 Axiom',
};

// Directories to skip entirely during the recursive walk.
const SKIP_DIRS = new Set(['node_modules', 'scripts', '.git']);

// ─── safety ──────────────────────────────────────────────────────────────────

/**
 * Throws if `child` is not strictly inside `parent`.
 * Prevents any write from escaping the target folder.
 */
function assertWithin(parent, child) {
  const safeParent = normalize(resolve(parent)) + '/';
  const safeChild  = normalize(resolve(child));
  if (!safeChild.startsWith(safeParent)) {
    throw new Error(`Safety violation: "${child}" is outside target folder "${parent}"`);
  }
}

// ─── file discovery ───────────────────────────────────────────────────────────

/** Recursively collect every index.html under dir, honouring SKIP_DIRS. */
function findIndexFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findIndexFiles(full));
    } else if (entry.isFile() && entry.name === 'index.html') {
      results.push(full);
    }
  }
  return results;
}

/** Map an index.html absolute path to its URL route. */
function routeFor(filePath, rootDir) {
  const rel = relative(rootDir, filePath); // e.g. "about/index.html"
  const dir = dirname(rel);               // e.g. "about" or "."
  return dir === '.' ? '/' : `/${dir}`;
}

// ─── badge removal ────────────────────────────────────────────────────────────

/**
 * Remove the first element with id="<id>" using balanced tag-depth counting,
 * so nested child elements are included correctly.
 * Returns { html, found }.
 */
function removeElementById(html, id) {
  // Match the opening tag that carries the id (any tag name).
  const openRe = new RegExp(`<(\\w+)(?=[^>]*\\bid="${id}")[^>]*>`, 'i');
  const match  = openRe.exec(html);
  if (!match) return { html, found: false };

  const tag      = match[1].toLowerCase();
  const start    = match.index;
  const openFull = match[0];

  // Self-closing element — just remove the tag itself.
  if (openFull.endsWith('/>')) {
    return {
      html:  html.slice(0, start) + html.slice(start + openFull.length),
      found: true,
    };
  }

  // Walk forward counting open/close pairs to find the balanced closing tag.
  const closeTag = `</${tag}>`;
  let depth = 1;
  let pos   = start + openFull.length;

  while (pos < html.length && depth > 0) {
    const nextClose = html.indexOf(closeTag, pos);
    // Look for another opening of the same tag (e.g. nested <div>).
    const nextOpenIdx = html.indexOf(`<${tag}`, pos);
    const nextOpenIsTag =
      nextOpenIdx !== -1 &&
      /^[\s>/]/.test(html[nextOpenIdx + tag.length + 1] ?? '');

    if (nextClose === -1) {
      // Malformed HTML — cannot balance.
      console.warn(`  WARNING: unbalanced <${tag}> for id="${id}"; badge may not be fully removed`);
      break;
    }

    if (nextOpenIsTag && nextOpenIdx < nextClose) {
      depth++;
      pos = nextOpenIdx + tag.length + 1;
    } else {
      depth--;
      if (depth === 0) {
        const end = nextClose + closeTag.length;
        return { html: html.slice(0, start) + html.slice(end), found: true };
      }
      pos = nextClose + closeTag.length;
    }
  }

  return { html, found: false };
}

// ─── diff summary ─────────────────────────────────────────────────────────────

/**
 * Print a compact line-level diff (changed lines only, truncated to 120 chars).
 * Avoids printing identical lines to keep output readable for large HTML files.
 */
function printDiff(before, after) {
  const bLines = before.split('\n');
  const aLines = after.split('\n');
  const len    = Math.max(bLines.length, aLines.length);
  let shown    = 0;

  for (let i = 0; i < len; i++) {
    const b = bLines[i] ?? '';
    const a = aLines[i] ?? '';
    if (b === a) continue;
    const fmt = s => s.trim().slice(0, 120);
    if (b) console.log(`    - ${fmt(b)}`);
    if (a) console.log(`    + ${fmt(a)}`);
    shown++;
  }
  if (shown === 0) {
    // Character-level change (e.g. within a single very long line).
    console.log(`    (changes within a single line; char delta: ${after.length - before.length})`);
  }
}

// ─── patch one file ───────────────────────────────────────────────────────────

function patchFile(filePath, rootDir) {
  assertWithin(rootDir, filePath);

  const route    = routeFor(filePath, rootDir);
  const original = readFileSync(filePath, 'utf8');
  let   html     = original;
  const ops      = [];

  // ── (a) canonical + og:url ────────────────────────────────────────────────
  if (SITE_HOST) {
    const target = `${SITE_HOST}${route}`;

    const c0 = html;
    // Handles both attribute orderings Framer might emit.
    html = html.replace(
      /(<link\b[^>]*\brel="canonical"[^>]*\bhref=")[^"]*(")/gi,
      `$1${target}$2`
    );
    html = html.replace(
      /(<link\b[^>]*\bhref=")[^"]*("[^>]*\brel="canonical"[^>]*)/gi,
      `$1${target}$2`
    );
    if (html !== c0) ops.push(`canonical -> ${target}`);

    const c1 = html;
    html = html.replace(
      /(<meta\b[^>]*\bproperty="og:url"[^>]*\bcontent=")[^"]*(")/gi,
      `$1${target}$2`
    );
    html = html.replace(
      /(<meta\b[^>]*\bcontent=")[^"]*("[^>]*\bproperty="og:url"[^>]*)/gi,
      `$1${target}$2`
    );
    if (html !== c1) ops.push(`og:url -> ${target}`);
  }

  // ── (b) <title> ───────────────────────────────────────────────────────────
  const newTitle = TITLE_MAP[route];
  if (!newTitle) {
    console.warn(`  WARNING: no TITLE_MAP entry for route "${route}"`);
  } else {
    const titleRe = /<title>[^<]*<\/title>/i;
    const oldMatch = titleRe.exec(html);
    if (!oldMatch) {
      console.warn(`  WARNING: no <title> tag found`);
    } else {
      const replacement = `<title>${newTitle}</title>`;
      if (oldMatch[0] !== replacement) {
        html = html.slice(0, oldMatch.index) + replacement +
               html.slice(oldMatch.index + oldMatch[0].length);
        ops.push(`title`);
      }
    }
  }

  // ── (c) Framer badge ──────────────────────────────────────────────────────
  let badgeFound = false;

  // 1. DOM element with id="__framer-badge-container"
  const { html: noEl, found: elFound } = removeElementById(html, '__framer-badge-container');
  if (elFound) {
    html       = noEl;
    badgeFound = true;
    ops.push('badge element removed');
  }

  // 2. Any <script> whose content references "__framer-badge"
  {
    const before = html;
    html = html.replace(
      /<script\b[^>]*>[\s\S]*?__framer-badge[\s\S]*?<\/script>/gi,
      () => ''
    );
    if (html !== before) {
      badgeFound = true;
      ops.push('badge <script> removed');
    }
  }

  // 3. CSS selector rules containing "__framer-badge" inside any <style> block
  {
    let cssHit = false;
    html = html.replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
      (_, open, body, close) => {
        const cleaned = body.replace(
          /[^{}]*__framer-badge[^{}]*\{[^}]*\}/gi,
          () => { cssHit = true; return ''; }
        );
        return `${open}${cleaned}${close}`;
      }
    );
    if (cssHit) {
      badgeFound = true;
      ops.push('badge CSS rules removed');
    }
  }

  if (!badgeFound) {
    console.warn(`  WARNING: Framer badge not found — verify manually`);
  }

  // ── write + report ────────────────────────────────────────────────────────
  if (html === original) {
    console.log(`  (no changes)\n`);
    return;
  }

  writeFileSync(filePath, html, 'utf8');
  printDiff(original, html);
  console.log(`  => ${ops.join(' | ')}\n`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

const [,, exportArg] = process.argv;
if (!exportArg) {
  console.error('Usage: node scripts/patch-export.mjs <path-to-export-folder>');
  process.exit(1);
}

const rootDir = resolve(exportArg);

const rootStat = statSync(rootDir, { throwIfNoEntry: false });
if (!rootStat?.isDirectory()) {
  console.error(`Error: "${exportArg}" is not a directory (resolved: ${rootDir})`);
  process.exit(1);
}

const files = findIndexFiles(rootDir);
if (files.length === 0) {
  console.error('No index.html files found. Is the path correct?');
  process.exit(1);
}

console.log(`Target : ${rootDir}`);
console.log(`Files  : ${files.length} index.html`);
console.log(`Host   : ${SITE_HOST ?? '(null \u2014 canonical/og:url untouched)'}`);
console.log('');

for (const f of files) {
  const route = routeFor(f, rootDir);
  console.log(`[${route}]`);
  patchFile(f, rootDir);
}

console.log('Done.');
