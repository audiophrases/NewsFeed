// RSS 2.0, RSS 1.0 (RDF) and Atom parsing into articles. The text helpers come from
// Play the News' server; parsing reads every item instead of stopping at the first audio one.
'use strict';

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', euro: '€', copy: '©',
  middot: '·', bull: '•', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', oacute: 'ó', iacute: 'í',
  uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß',
};

function entities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] !== '#') return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(code); } catch (err) { return m; }
  });
}

/** Text of an element's content: CDATA kept as is, everything else entity-decoded. */
function content(raw) {
  let out = '', last = 0;
  for (const m of raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)) {
    out += entities(raw.slice(last, m.index)) + m[1];
    last = m.index + m[0].length;
  }
  return (out + entities(raw.slice(last))).trim();
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function tagText(xml, tag) {
  const t = escapeRe(tag);
  const m = new RegExp(`<${t}(?:\\s[^>]*[^/>])?\\s*>([\\s\\S]*?)</${t}>`).exec(xml);
  return m ? content(m[1]) : null;
}

function tagTexts(xml, tag) {
  const t = escapeRe(tag);
  return [...xml.matchAll(new RegExp(`<${t}(?:\\s[^>]*[^/>])?\\s*>([\\s\\S]*?)</${t}>`, 'g'))]
      .map(m => content(m[1])).filter(Boolean);
}

function attrOf(tag, name) {
  const m = new RegExp(`\\s${escapeRe(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? entities(m[1] ?? m[2]) : null;
}

function tags(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${escapeRe(tag)}\\b[^>]*>`, 'g'))].map(m => m[0]);
}

function attr(xml, tag, name) {
  const t = tags(xml, tag)[0];
  return t ? attrOf(t, name) : null;
}

/** HTML (as feeds embed it) to plain text with paragraph breaks. */
function htmlToText(html) {
  if (!html) return '';
  return entities(html
      .replace(/<(script|style|noscript|iframe)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''))
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
}

function firstImage(html) {
  const m = html && /<img\b[^>]*>/i.exec(html);
  const src = m && (attrOf(m[0], 'src') || attrOf(m[0], 'data-src'));
  return src && /^https?:\/\//i.test(src) ? src : null;
}

function parseDate(s) {
  const t = s ? Date.parse(s.trim()) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function absolute(link, base) {
  if (!link) return null;
  try {
    const u = new URL(link.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch (e) {
    return null;
  }
}

/** Atom's article link: rel="alternate" or no rel. RSS: the <link> element's text. */
function itemLink(item, base) {
  for (const t of tags(item, 'link')) {
    const rel = attrOf(t, 'rel');
    const href = attrOf(t, 'href');
    if (href && (!rel || rel === 'alternate')) return absolute(href, base);
  }
  const text = tagText(item, 'link');
  if (text) return absolute(text, base);
  const guid = tags(item, 'guid')[0];
  if (guid && attrOf(guid, 'isPermaLink') !== 'false') return absolute(tagText(item, 'guid'), base);
  return null;
}

function itemImage(item, html) {
  for (const t of [...tags(item, 'media:thumbnail'), ...tags(item, 'media:content'), ...tags(item, 'enclosure')]) {
    const url = attrOf(t, 'url');
    const type = attrOf(t, 'type') || '';
    const medium = attrOf(t, 'medium') || '';
    if (url && (t.startsWith('<media:thumbnail') || type.startsWith('image') || medium === 'image'
        || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url))) return url;
  }
  return attr(item, 'itunes:image', 'href') || firstImage(html);
}

const SUMMARY_MAX = 600;

function shorten(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40)) + '…';
}

/** Google News titles end in " - Publisher"; Bing's don't. */
function splitPublisher(title, publisher) {
  if (publisher && title.endsWith(' - ' + publisher)) return title.slice(0, -publisher.length - 3);
  return title;
}

/** The feed's title, site, language, and its articles in feed order. */
function parseFeed(xml, url) {
  if (!/<(rss|feed|rdf:RDF|channel)[\s>]/i.test(xml)) throw new Error('Not an RSS or Atom feed');
  const firstItem = xml.search(/<(item|entry)[\s>]/);
  const head = firstItem >= 0 ? xml.slice(0, firstItem) : xml;
  const language = tagText(head, 'language') || /<feed[^>]*\sxml:lang="([^"]+)"/.exec(head)?.[1] || null;
  const items = [];
  for (const m of xml.matchAll(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g)) {
    const item = m[0];
    const html = tagText(item, 'content:encoded') || tagText(item, 'content') || '';
    const description = tagText(item, 'description') || tagText(item, 'summary') || '';
    const publisher = tagText(item, 'source');
    const sourceTag = tags(item, 'source')[0];
    const rawTitle = htmlToText(tagText(item, 'title') || '');
    const link = itemLink(item, url);
    const title = splitPublisher(rawTitle, publisher);
    if (!title && !link) continue;
    let summary = htmlToText(description || html);
    // Google News' description just repeats the headline and publisher.
    if (publisher && summary.startsWith(title)) summary = '';
    items.push({
      id: tagText(item, 'guid') || tagText(item, 'id') || link || title,
      title: title || '(untitled)',
      link,
      summary: shorten(summary, SUMMARY_MAX),
      hasContent: html.length > 0,
      image: absolute(itemImage(item, html || description), url),
      author: htmlToText(tagText(item, 'dc:creator') || tagText(item, 'name') || tagText(item, 'author') || '') || null,
      publisher: publisher || null,
      // Google News names the outlet's site: <source url="https://outlet.example">Outlet</source>.
      publisherUrl: (sourceTag && absolute(attrOf(sourceTag, 'url'), url)) || null,
      categories: [...tagTexts(item, 'category'), ...tags(item, 'category').map(t => attrOf(t, 'term')).filter(Boolean)]
          .map(htmlToText).filter((c, i, all) => c && all.indexOf(c) === i).slice(0, 6),
      publishedAt: parseDate(tagText(item, 'pubDate') || tagText(item, 'published')
          || tagText(item, 'dc:date') || tagText(item, 'updated')),
    });
  }
  const siteLink = itemLink(head, url);
  return {
    title: htmlToText(tagText(head, 'title') || '') || new URL(url).hostname,
    siteUrl: siteLink && siteLink !== url ? siteLink : new URL(url).origin,
    language: language ? language.toLowerCase().split(/[-_]/)[0] : null,
    items,
  };
}

/** Feeds a web page announces: <link rel="alternate" type="application/rss+xml" href="...">. */
function feedLinks(html, base) {
  const found = [];
  for (const t of tags(html, 'link')) {
    const rel = (attrOf(t, 'rel') || '').toLowerCase().split(/\s+/);
    const type = (attrOf(t, 'type') || '').toLowerCase();
    if (!rel.includes('alternate') || !/(rss|atom)\+xml|application\/(rss|atom|feed)/.test(type)) continue;
    const url = absolute(attrOf(t, 'href'), base);
    if (url && !found.some(f => f.url === url)) found.push({ url, title: attrOf(t, 'title') || null });
  }
  return found;
}

const looksLikeFeed = text => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)[\s>]/i.test(text);

module.exports = { parseFeed, feedLinks, looksLikeFeed, htmlToText, entities, attrOf, tags, absolute, parseDate };
