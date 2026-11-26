# NewsFeed

A news reader for the sources and topics you follow. Every article they publish lands in
one list that you can **search, filter, sort and read**, on a PC or on your phone.

Built from the web version of [Play the News](https://github.com/audiophrases/playthenews):
the same small dependency-free Node server (it fetches feeds for the browser, which most news
sites don't allow directly), the same feed parsing, caching and encoding handling, the same
dark look and the same flags.

## Run it

Needs [Node.js](https://nodejs.org) 18 or newer, nothing else.

```
node server.js        # or double-click start.cmd on Windows
```

Open the address it prints (default `http://localhost:8091`). Phones on the same Wi-Fi can
use the "on your Wi-Fi" address. `PORT=…` changes the port, `HOST=127.0.0.1` keeps it to this PC.

## Put it online (Render)

To use it from anywhere, host it on a free [Render](https://render.com) account. Click the
button, sign in to Render and **Apply** the Blueprint: Render reads `render.yaml` and sets
everything up.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/audiophrases/NewsFeed)

When it shows **Live**, open the `https://newsfeed-….onrender.com` address it gives you.
Every push to `main` redeploys it. A free service sleeps after 15 minutes without visits, so
the first visit after that takes up to a minute.

By hand instead: **New ➜ Web Service**, connect `https://github.com/audiophrases/NewsFeed`,
Language **Node**, Build Command `npm install`, Start Command `node server.js`, Instance Type
**Free**.

## What it does

- **Sources** – about 50 built-in news feeds (world, technology, science, business, sport, and
  news in German, French, Spanish, Catalan, Italian and Portuguese), or **search for any outlet
  by name** ("El Nacional", "Betevé") in *Add sources*: NewsFeed finds the outlets Google News
  knows by that name and the feeds Feedly lists for it, checks every feed works, and shows each
  with its newest headline. A site's or feed's address works too. For a site whose feed can't be
  read, you can follow its headlines via Google News instead (a `site:` search, listed with your
  sources). The same goes for a feed that stops letting NewsFeed read it (HTTP 401/403): its page
  offers to switch it to its section's or site's headlines via Google News. The Guardian refuses
  NewsFeed's server, so its built-in sources work this way. Section feeds
  are named after their site ("The Economist – Europe"). Sources show their country's flag, or the
  site's own icon when the country isn't known; topic articles show their outlet's icon. NewsFeed's
  server finds and caches the icons, so no icon service learns which sites you follow.
- **Topics** – follow anything ("climate", `"champions league"`, `AI -crypto`) and get headlines
  about it from every outlet, via Google News (Bing News as a fallback), in the edition you pick,
  and **also in as many other languages as you like**. Names work as they are in every language; for other
  words add the translations with OR: `housing OR vivienda OR habitatge`. A topic's view also
  includes matching articles from your own sources. Its articles open in the reader like any
  other: Google News links don't name the article's address, so when you open one the server asks
  Google where it leads (the lookup Google's own article page makes in a browser; not a published
  API, so it may change), then reads the article from its site. It asks only for articles you
  open, one at a time; your browser and the server remember every answer, and after Google
  refuses a lookup (or redirects it, as it may for servers in data centres) the server leaves it
  alone for 30 minutes. When Google won't say, the article is looked for on its own site by its
  headline: in the site's feeds, among the links on its home page (some sites' feeds are years
  out of date), in its WordPress search feed and public search index, and in its sitemaps. If those
  miss, NewsFeed searches Bing News for the headline on the publisher's domain and checks the
  result against the headline and outlet. NewsFeed also checks the publisher’s HTML search
  results. When the server runs out of matches, the browser can check a publisher’s public
  WordPress index directly. If the headlines differ, **Use a publisher link** lets you paste
  the article’s address. NewsFeed opens it in the reader and remembers it on that device.
- **Edit** – the ✎ next to *Topics* or *Sources* lists everything you follow: type to rename
  (empty gives back the original name), reorder with the arrows or by dragging the handle, remove,
  or open more settings: a feed's flag, language and address; a Google News source's site, edition
  and flag; a topic's words, edition and other languages. The ✎ next to a source's or topic's
  title opens its settings directly.
- **Search** – as you type, searches everything loaded (titles, summaries, authors, sources,
  categories), accent-insensitive, with `"exact phrases"`, `-excluded` words and `OR` between
  alternatives; matches are highlighted.
  **Enter** (or "Search all news too") searches all news as well: your news's matches and a news
  search of every outlet, as a topic's, in one list with each story once. It says how many are in
  your news and how many more it found, searches in the languages you pick there (as many as you
  like; at first your browser's, then whichever you used last, which new topics start from too), updates with the rest, and is kept only if you **Follow as a
  topic**.
- **Filter** – by source or topic, unread only, saved, time (last hour … this week) and language.
- **Order** – newest first, oldest first, by source, or best match while searching.
- **Read** – a reader pane with the feed's text, and the full article fetched and cleaned up
  (text only, no ads, scripts, cookie notices or "follow us" lines) when the site allows it; one
  click to the original. A line under the headline says how much of the article you have:
  **✓ Full article** when it is as long as the page says the article is, **⚠ Only part of the
  article** when it is clearly shorter (or is the opening of a subscriber article), **Text from the
  page** when the site doesn't say how long it is, or **Summary only** with the reason (subscribers
  only, the site refuses NewsFeed, found through Google News…). Articles a site marks for
  subscribers carry a **Subscriber article** tag. The length and subscriber flag come from the
  page's own JSON-LD description (`wordCount`, `articleBody`, `isAccessibleForFree`).
- **Article-only reading** – NewsFeed removes consent dialogs before extracting the body. If the
  page is thin, it can also read a matching public WordPress post or use
  [Mozilla’s Readability](https://github.com/mozilla/readability) to recover paragraphs, images
  and captions. When the publisher supplies only a headline or summary, that stays in the reader.
  Use the 🌐 button (or `w`) to open the publisher’s own page in NewsFeed if it allows embedding.
  The same button returns to the article.
  Reading an article from an outlet you don't follow yet (from a topic, a search or a saved
  article), **+ Add source** next to its name adds that outlet. It finds the feeds on the outlet's
  site and ticks the only one, or ticks the outlet's headlines via Google News when the site has
  no feed NewsFeed can read. If the outlet's site isn't known, it searches by the outlet's name.
- **Keep track** – read/unread, saved articles (kept even after they leave the feed), duplicate
  stories shown once, unread counts per source, refresh every 15 minutes, or pull the list
  down on a phone to update it now.
- **Keyboard** – `j`/`k` next/previous, `s` save, `m` read/unread, `o` open original,
  `f` full text, `w` the site's page, `-`/`+` text size, `/` search, `r` refresh.
- **Text size** – **−** and **+** in the reader's bar make the article's headline and text
  smaller or larger (80% to 200%, remembered); the site's own page zooms along.
- **Full screen** – the ⛶ button in the reader's bar hides NewsFeed's search bar while an article
  is open; on wide screens the sidebar and list too, leaving just the article (`j`/`k` still move
  on). It doesn't ask the browser for full screen, so Chrome shows no "swipe to exit" notice. The
  same button or Esc ends it.
- **Export / Import** – your sources, topics and saved articles as JSON; OPML from other feed
  readers can be imported too.
- **Sync** – sign in with Google (PinPlay's sign-in) on each of your devices, and what you follow,
  what you've read (and marked unread) and what you've saved stay the same on all of them. Each
  change goes a moment after you make it; the others' changes come with every refresh, when
  NewsFeed comes back into view and every 5 minutes. Made offline, a change waits for the
  connection. When you sign in, what that device has joins your account. For a read mark or a
  saved article, the latest change wins. When two devices changed your sources, both sets of
  changes are kept: sources added on either device stay, and a source removed on either goes.
  Only on a NewsFeed set up for it (see below).

Your sources, read marks, saved articles and settings are stored in the browser (per device), and
in your sync account if you sign in.

## Sync between devices

Sync is a small Cloudflare Worker in [`sync/`](sync/) (free plan). It uses PinPlay's Google OAuth
client for sign-in, but not PinPlay itself or its student roster: the worker checks Google's token
itself, issues its own sign-in (180 days) and keeps each account's data in a Durable Object of its
own. To set it up:

1. **Deploy the worker** (once; again after changing `sync/`):

   ```sh
   cd sync
   npx wrangler deploy                       # prints https://newsfeed-sync.<you>.workers.dev
   npx wrangler secret put SESSION_KEY       # a long random value: openssl rand -hex 32
   npx wrangler secret put ALLOWED_EMAILS    # optional: who may sync, e.g. you@gmail.com
   ```

   Without `ALLOWED_EMAILS` any Google account can sign in and sync its own data. Removing an
   address from it signs that account out everywhere.
2. **Tell NewsFeed where it is**: set `SYNC_URL` to the worker's address, on Render under the
   service's *Environment*, or before `node server.js` locally. Without it there's no sign-in.
3. **Let NewsFeed use the Google sign-in**: in Google Cloud Console, *APIs & Services ➜
   Credentials*, open PinPlay's OAuth client and add each address NewsFeed is opened at to
   *Authorized JavaScript origins* (your `https://newsfeed-….onrender.com`, and
   `http://localhost` and `http://localhost:8091` for this PC). Google offers sign-in only on
   those. A phone on your Wi-Fi (`http://192.168.…`) can't be added, so sign in there through Render.

## API (used by the page)

| Endpoint | |
| --- | --- |
| `GET /api/directory` | built-in sources (`sources.json`) |
| `GET /api/config` | the sync service's address (`SYNC_URL`), or null |
| `GET /api/feed?url=` | a feed's articles |
| `GET /api/search?q=&editions=ca-ES,en-US` | news about a topic, in one or more editions (up to 5; or `lang=&country=`) |
| `GET /api/sources?q=&lang=&country=` | outlets and working feeds for a name |
| `GET /api/discover?url=` | feeds a site offers |
| `GET /api/icon?url=` | the icon of that address's site (cached a day; 404 if it has none) |
| `GET /api/article?url=` | an article's readable text and how complete it is (a Google News link is looked up first) |
| `GET /api/page?url=` | an article's page without scripts or styles, for the browser's reading view, and whether it may be framed |

The server won't fetch addresses on your local network (so a page can't use it to reach your
router etc.). Set `ALLOW_PRIVATE=1` if you want to read feeds hosted on your own network.

## Tests

```
npm test
```

Parsing (RSS, RDF, Atom, Google News, ISO-8859-1), feed discovery, article extraction and the
server end to end against a local fixture site; the sync worker's sign-in and syncing against real
SQLite (Node's `node:sqlite`), and merging two devices' source lists.
