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

## What it does

- **Sources** – about 50 built-in news feeds (world, technology, science, business, sport, and
  news in German, French, Spanish, Catalan, Italian and Portuguese), any site's RSS/Atom feed,
  or just a site's address: NewsFeed finds its feeds for you.
- **Topics** – follow anything ("climate", `"champions league"`, `AI -crypto`) and get headlines
  about it from every outlet, via Google News (Bing News as a fallback), in the edition you pick.
  A topic's view also includes matching articles from your own sources.
- **Search** – searches everything loaded (titles, summaries, authors, sources, categories),
  accent-insensitive, with `"exact phrases"` and `-excluded` words; matches are highlighted.
  "Search all news" runs the same words as a news search beyond your sources, which you can
  then follow as a topic.
- **Filter** – by source or topic, unread only, saved, time (last hour … this week) and language.
- **Order** – newest first, oldest first, by source, or best match while searching.
- **Read** – a reader pane with the feed's text, and the full article fetched and cleaned up
  (text only, no ads or scripts) when the site allows it; one click to the original.
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
| `GET /api/search?q=&lang=en&country=US` | news about a topic |
| `GET /api/discover?url=` | feeds a site offers |
| `GET /api/article?url=` | an article's readable text |

The server won't fetch addresses on your local network (so a page can't use it to reach your
router etc.). Set `ALLOW_PRIVATE=1` if you want to read feeds hosted on your own network.

## Tests

```
npm test
```

Parsing (RSS, RDF, Atom, Google News, ISO-8859-1), feed discovery, article extraction and the
server end to end against a local fixture site.
