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
  read, you can follow its headlines via Google News instead (a `site:` search). Section feeds
  are named after their site ("The Economist – Europe"). Sources show their country's flag, or the
  site's own icon when the country isn't known; topic articles show their outlet's icon. NewsFeed's
  server finds and caches the icons, so no icon service learns which sites you follow.
- **Topics** – follow anything ("climate", `"champions league"`, `AI -crypto`) and get headlines
  about it from every outlet, via Google News (Bing News as a fallback), in the edition you pick,
  and **also in up to four other languages**. Names work as they are in every language; for other
  words add the translations with OR: `housing OR vivienda OR habitatge`. A topic's view also
  includes matching articles from your own sources.
- **Search** – searches everything loaded (titles, summaries, authors, sources, categories),
  accent-insensitive, with `"exact phrases"`, `-excluded` words and `OR` between alternatives;
  matches are highlighted.
  "Search all news" runs the same words as a news search beyond your sources, which you can
  then follow as a topic.
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
- **Keep track** – read/unread, saved articles (kept even after they leave the feed), duplicate
  stories shown once, unread counts per source, refresh every 15 minutes.
- **Keyboard** – `j`/`k` next/previous, `s` save, `m` read/unread, `o` open original,
  `f` full text, `/` search, `r` refresh.
- **Export / Import** – your sources, topics and saved articles as JSON; OPML from other feed
  readers can be imported too.

Your sources, read marks, saved articles and settings are stored in the browser (per device).

## API (used by the page)

| Endpoint | |
| --- | --- |
| `GET /api/directory` | built-in sources (`sources.json`) |
| `GET /api/feed?url=` | a feed's articles |
| `GET /api/search?q=&editions=ca-ES,en-US` | news about a topic, in one or more editions (up to 5; or `lang=&country=`) |
| `GET /api/sources?q=&lang=&country=` | outlets and working feeds for a name |
| `GET /api/discover?url=` | feeds a site offers |
| `GET /api/icon?url=` | the icon of that address's site (cached a day; 404 if it has none) |
| `GET /api/article?url=` | an article's readable text |

The server won't fetch addresses on your local network (so a page can't use it to reach your
router etc.). Set `ALLOW_PRIVATE=1` if you want to read feeds hosted on your own network.

## Tests

```
npm test
```

Parsing (RSS, RDF, Atom, Google News, ISO-8859-1), feed discovery, article extraction and the
server end to end against a local fixture site.
