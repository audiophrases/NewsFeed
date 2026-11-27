// NewsFeed: a news reader for the sources and topics you follow. Serves the reader page and,
// because most news sites don't let browsers read their feeds directly, fetches feeds, news
// searches and article pages for it (lib/api.js, which the NewsFeed app runs on the phone
// instead). Built from Play the News' web server.
//
//   node server.js      then open the address it prints, on this PC or a phone on the same Wi-Fi
//
// No dependencies beyond Node 18+.
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const fetcher = require('./lib/fetch');
const { createApi } = require('./lib/api');

const PORT = Number(process.env.PORT) || 8091;
// All interfaces, so phones on the same Wi-Fi can connect; HOST=127.0.0.1 keeps it to this PC.
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const DIRECTORY = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

const api = createApi({
  fetcher,
  directory: DIRECTORY,
  // Read when asked, so a change (the tests make some) counts at once.
  env: process.env,
  gunzip: async bytes => zlib.gunzipSync(bytes),
  warn: text => console.warn(text),
});

// ---- HTTP --------------------------------------------------------------------------------

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function file(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, TYPES[path.extname(filePath)] || 'application/octet-stream',
        { 'X-Content-Type-Options': 'nosniff' });
  });
}

/** Most of a page the NewsFeed app may send for its text (as JSON, so a little over the page). */
const EXTRACT_MAX_BYTES = 4 * 1024 * 1024;

/** A request's body as text, at most max bytes (null if longer: the rest is read and dropped, so the answer arrives). */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > max) chunks = null;
      else if (chunks) chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks ? Buffer.concat(chunks).toString('utf8') : null));
    req.on('error', reject);
  });
}

/** An API answer (lib/api.js) as an HTTP response. */
function answer(res, result) {
  if (result.json !== undefined) return json(res, result.status, result.json);
  if (result.status === 404) {
    return send(res, 404, 'No icon', 'text/plain', { 'Cache-Control': 'public, max-age=86400' });
  }
  // An icon: bytes from another site, so never let them run as a page here (an SVG could try).
  return send(res, 200, result.bytes, result.type, {
    'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && u.pathname === '/api/extract') {
    // The NewsFeed app used to send pages it read here; it reads them itself now, but an older
    // copy of the app may still.
    const body = await readBody(req, EXTRACT_MAX_BYTES);
    if (body === null) return json(res, 413, { error: 'The page is too large' });
    return answer(res, await api.handle('POST', u, body));
  }
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');
  if (u.pathname === '/health') return send(res, 200, 'ok', 'text/plain');

  const result = await api.handle('GET', u);
  if (result) return answer(res, result);

  const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
  const filePath = path.join(PUBLIC, rel);
  if (!filePath.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found', 'text/plain');
  return file(res, filePath);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'Server error', 'text/plain');
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`NewsFeed: ${DIRECTORY.sources.length} built-in sources`);
    console.log(`  on this PC:    http://localhost:${PORT}`);
    if (HOST !== '0.0.0.0') return;
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const n of nets) {
        if (n.family === 'IPv4' && !n.internal) console.log(`  on your Wi-Fi: http://${n.address}:${PORT}`);
      }
    }
  });
}

module.exports = { server };
