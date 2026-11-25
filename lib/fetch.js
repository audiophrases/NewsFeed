// Fetching pages and feeds for the browser, which can't read most of them itself (CORS).
// Adapted from Play the News' server: same browser-like User-Agent, timeout and encoding
// handling, plus a size cap and a check that links don't point into the local network.
'use strict';

const dns = require('dns').promises;
const net = require('net');

// Some CDNs reject anything that does not look like a browser.
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const TIMEOUT_MS = 15000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Set ALLOW_PRIVATE=1 to read feeds on your own network (and for the tests). */
const allowPrivate = () => process.env.ALLOW_PRIVATE === '1';

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

class FetchError extends Error {}

async function checkHost(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('Not a web address');
  if (allowPrivate()) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addresses.some(a => isPrivateAddress(a.address))) throw new FetchError('Address is on a private network');
}

/** GET with redirects followed by hand, so every hop is checked. */
async function get(url, headers = {}) {
  for (let hop = 0; ; hop++) {
    await checkHost(url);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en,*;q=0.5', ...headers },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new FetchError('Too many redirects');
      url = new URL(location, url).href;
      continue;
    }
    if (!res.ok) {
      res.body?.cancel();
      throw new FetchError(`HTTP ${res.status}`);
    }
    return { res, url };
  }
}

/** A decoder for the document's own encoding (some are ISO-8859-1, which UTF-8 would garble). */
function decoderFor(firstChunk, res) {
  const start = Buffer.from(firstChunk.subarray(0, 1024)).toString('latin1');
  const declared = /<\?xml[^>]*encoding=["']([\w-]+)/i.exec(start)
      || /charset=([\w-]+)/i.exec(res.headers.get('content-type') || '')
      || /<meta[^>]+charset=["']?([\w-]+)/i.exec(start);
  try {
    return new TextDecoder(declared ? declared[1] : 'utf-8');
  } catch (e) {
    return new TextDecoder('utf-8');
  }
}

/** The page's text, decoded, at most maxBytes of it; and its address after redirects. */
async function getText(url, headers, maxBytes = MAX_BYTES) {
  const { res, url: finalUrl } = await get(url, headers);
  const reader = res.body.getReader();
  let decoder = null, text = '', size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        decoder = decoder || decoderFor(value, res);
        size += value.length;
        text += decoder.decode(value, { stream: true });
        if (size >= maxBytes) break;
      }
      if (done) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { text: text + (decoder ? decoder.decode() : ''), url: finalUrl, type: res.headers.get('content-type') || '' };
}

/** A POST with a form body, for the one lookup that needs it; the answer's text (small). */
async function postText(url, body, headers = {}) {
  await checkHost(url);
  const res = await fetch(url, {
    method: 'POST',
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', ...headers },
  });
  if (!res.ok) {
    res.body?.cancel();
    // Say where a redirect went (a consent page, a check for unusual traffic…): that's the reason.
    const location = res.headers.get('location');
    let to = '';
    try {
      if (location) to = ` to ${new URL(location, url).hostname}${new URL(location, url).pathname}`;
    } catch (e) {
      // no usable address
    }
    throw new FetchError(`HTTP ${res.status}${to}`);
  }
  return (await res.text()).slice(0, MAX_BYTES);
}

/** A small file's bytes (an image, say); null if it is bigger than maxBytes. */
async function getBytes(url, headers, maxBytes) {
  const { res, url: finalUrl } = await get(url, headers);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        size += value.length;
        if (size > maxBytes) return null;
        chunks.push(value);
      }
      if (done) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { bytes: Buffer.concat(chunks), url: finalUrl, type: res.headers.get('content-type') || '' };
}

/** A short reason for the browser: fetch's own message is just "fetch failed". */
function reason(e) {
  if (e.name === 'TimeoutError') return 'Timed out';
  const cause = e.cause && (e.cause.code || e.cause.message);
  return cause ? `${e.message} (${cause})` : e.message;
}

module.exports = { get, getText, getBytes, postText, reason, isPrivateAddress, FetchError, USER_AGENT };
