'use strict';

// Site icons for sources without a flag (lib/icons.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const { iconCandidates, imageType } = require('../lib/icons');

test('icons a page names, nearest 64px first (a link listing several sizes counts its largest), then /favicon.ico', () => {
  const html = `<link rel="icon" href="/f16.png" sizes="16x16">
    <link rel="apple-touch-icon" href="/touch.png">
    <link rel="icon" type="image/png" href="https://cdn.example.com/f32.png" sizes="32x32">
    <link rel="shortcut icon" href="/f.ico"><link rel="stylesheet" href="/s.css">
    <link rel="icon" href="/f96.png" sizes="96x96 192x192">`;
  assert.deepEqual(iconCandidates(html, 'https://www.example.com/news').map(c => c.url), [
    'https://cdn.example.com/f32.png', 'https://www.example.com/touch.png', 'https://www.example.com/f96.png',
    'https://www.example.com/f16.png', 'https://www.example.com/f.ico', 'https://www.example.com/favicon.ico',
  ]);
  assert.deepEqual(iconCandidates('', 'https://example.org/').map(c => c.url), ['https://example.org/favicon.ico']);
});

test('images recognised by their bytes; pages are not images', () => {
  const bytes = hex => Buffer.from(hex, 'hex');
  assert.equal(imageType(bytes('89504e470d0a1a0a00')), 'image/png');
  assert.equal(imageType(bytes('000001000100101000')), 'image/x-icon');
  assert.equal(imageType(bytes('ffd8ffe000104a4649')), 'image/jpeg');
  assert.equal(imageType(Buffer.from('GIF89a...')), 'image/gif');
  assert.equal(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(imageType(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
  assert.equal(imageType(Buffer.from('<!doctype html><html><body>Not found</body></html>')), null);
});
