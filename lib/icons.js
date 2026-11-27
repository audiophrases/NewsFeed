// Site icons for sources that have no flag: the icon a site's home page names (as browsers show
// in tabs), else its /favicon.ico. The server fetches and caches them, so the browser only ever
// asks NewsFeed (no third-party icon service learns which sites you follow).
'use strict';

const { tags, attrOf, absolute } = require('./feeds');

/** Icons are small; anything bigger isn't worth sending to the sidebar. */
const ICON_MAX_BYTES = 100 * 1024;

/**
 * The icons a page names, best first: square ones near 64px (crisp at 16px on any screen), then
 * larger, then smaller; an apple-touch-icon without sizes is 180px; the site's /favicon.ico last.
 */
function iconCandidates(html, pageUrl) {
  const found = [];
  for (const t of tags(html, 'link')) {
    const rel = (attrOf(t, 'rel') || '').toLowerCase().split(/\s+/);
    const touch = rel.some(r => r.startsWith('apple-touch-icon'));
    if (!rel.includes('icon') && !touch) continue;
    const url = absolute(attrOf(t, 'href'), pageUrl);
    if (!url || found.some(f => f.url === url)) continue;
    const sizes = (attrOf(t, 'sizes') || '').split(/\s+/).map(s => parseInt(s, 10)).filter(n => n > 0);
    const svg = /\.svg(\?|$)/i.test(url) || /svg/i.test(attrOf(t, 'type') || '');
    const size = sizes.length ? Math.max(...sizes) : touch ? 180 : svg ? 64 : 16;
    found.push({ url, size });
  }
  const rank = ({ size }) => (size >= 32 && size <= 192 ? 1000 - Math.abs(size - 64) : size > 192 ? 500 - size / 10 : size);
  found.sort((a, b) => rank(b) - rank(a));
  found.push({ url: new URL('/favicon.ico', pageUrl).href, size: 16 });
  return found;
}

/** The image type from the bytes themselves (servers often label .ico files wrongly); null if not an image. */
function imageType(bytes) {
  const head = bytes.subarray(0, 16);
  // Plain bytes (a Buffer on the server, a Uint8Array in the NewsFeed app) as text.
  const text = (from, to) => String.fromCharCode(...head.subarray(from, to));
  if (head[0] === 0x89 && text(1, 4) === 'PNG') return 'image/png';
  if (text(0, 4) === 'GIF8') return 'image/gif';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head[0] === 0 && head[1] === 0 && (head[2] === 1 || head[2] === 2) && head[3] === 0) return 'image/x-icon';
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp';
  const start = new TextDecoder('utf-8').decode(bytes.subarray(0, 512)).replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(start)) return 'image/svg+xml';
  return null;
}

module.exports = { iconCandidates, imageType, ICON_MAX_BYTES };
