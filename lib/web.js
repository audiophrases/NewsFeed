// The parts of fetching that don't depend on how a page is fetched: the server's fetch (fetch.js,
// Node's) and the NewsFeed app's (public/local.js, the phone's) both use them.
'use strict';

const MAX_BYTES = 8 * 1024 * 1024;

class FetchError extends Error {}

/** A decoder for the document's own encoding (some are ISO-8859-1, which UTF-8 would garble). */
function decoderFor(firstChunk, headers) {
  const start = new TextDecoder('latin1').decode(firstChunk.subarray(0, 1024));
  const declared = /<\?xml[^>]*encoding=["']([\w-]+)/i.exec(start)
      || /charset=([\w-]+)/i.exec(headers.get('content-type') || '')
      || /<meta[^>]+charset=["']?([\w-]+)/i.exec(start);
  try {
    return new TextDecoder(declared ? declared[1] : 'utf-8');
  } catch (e) {
    return new TextDecoder('utf-8');
  }
}

/**
 * Whether a page lets other sites show it in a frame, by its X-Frame-Options and its Content
 * Security Policy's frame-ancestors. Only "anyone may" counts: a list of allowed sites won't
 * include NewsFeed's.
 */
function frameAllowed(headers) {
  if ((headers.get('x-frame-options') || '').trim()) return false;
  const policy = headers.get('content-security-policy') || '';
  const ancestors = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(policy);
  if (!ancestors) return true;
  return ancestors[1].trim().split(/\s+/).some(s => s === '*' || /^https?:$/i.test(s));
}

/** The error for a page that answered with something other than success. */
function statusError(status, headers, url) {
  // Cloudflare's bot check ("Just a moment…"): the site only lets browsers in. Asking it
  // again, or for another of its pages, gets the same answer.
  const challenge = headers.get('cf-mitigated') === 'challenge';
  const error = new FetchError(`HTTP ${status}${challenge ? ' (browser check)' : ''}`);
  error.requestUrl = url;
  error.challenge = challenge;
  error.frameable = frameAllowed(headers);
  return error;
}

/** Why a POST was refused: its status, and where a redirect went (a consent page, a check…). */
function postError(status, headers, url) {
  const location = headers.get('location');
  let to = '';
  try {
    if (location) to = ` to ${new URL(location, url).hostname}${new URL(location, url).pathname}`;
  } catch (e) {
    // no usable address
  }
  return new FetchError(`HTTP ${status}${to}`);
}

/** A short reason for the page: fetch's own message is just "fetch failed". */
function reason(e) {
  if (e.name === 'TimeoutError') return 'Timed out';
  const cause = e.cause && (e.cause.code || e.cause.message);
  return cause ? `${e.message} (${cause})` : e.message;
}

module.exports = { MAX_BYTES, FetchError, decoderFor, frameAllowed, statusError, postError, reason };
