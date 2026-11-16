# BBI Merch

Merch stock and sales tracker for Bastard Bearded Irishmen, built to run on a phone at the merch table.

## What it does

- **Stock:** add a design with its graphic and mock-up photo, the styles it comes in (T-shirt, hoodie, CD...), a price per style (with optional per-size prices), and a count for each size. Sizes at 3 or fewer show as low, 0 as sold out.
- **Sell:** tap an item, tap sizes to build a sale, then tap Cash or Card to record it. Stock goes down automatically, today's sales are listed with totals, and any sale can be undone.
- **No signal:** the page, fonts and photos are cached on the phone, and sales recorded offline are kept on the phone and sent when the connection comes back. The server records each sale once by its id, so a resend never double-counts stock.
- **One login:** a single shared password (`APP_PASSWORD`). Signing in keeps the phone signed in for a year.

## Running it

Needs Node 22.13 or newer (it uses the built-in `node:sqlite`). No npm packages.

```sh
APP_PASSWORD=choose-one SESSION_SECRET=some-long-random-string npm start
```

| Variable | Purpose |
|---|---|
| `APP_PASSWORD` | The password people type to sign in |
| `SESSION_SECRET` | Signs the login cookie; keep it the same across deploys or everyone gets signed out |
| `DATA_DIR` | Where the SQLite database lives (default `./data`). On Railway this is a volume mounted at `/data` |
| `PORT` | Set by Railway |

## Layout

- `server.js`: HTTP server and JSON API, SQLite storage for designs, sales and images
- `public/index.html`: the whole phone app (no build step)
- `public/sw.js`: service worker for offline use
- `seed/designs.json`: starting merch list (from the Square export), loaded only when the database is empty

## API

All `/api/*` routes except login need the session cookie.

| Route | What it does |
|---|---|
| `POST /api/login` `{password}` | Signs in |
| `GET /api/designs` | All designs with styles, sizes and stock |
| `PUT /api/designs/:id` | Create or replace a design |
| `DELETE /api/designs/:id` | Delete a design and its images |
| `POST /api/designs/:id/stock` `{styleId, size, stock}` | Set one size's count |
| `GET /api/sales?since=<ms>` | Sales since a time (default: last 2 days) |
| `POST /api/sales` `{id, at, items, payment}` | Record a sale and take it out of stock (idempotent by `id`) |
| `POST /api/sales/:id/void` | Undo a sale and put the stock back |
| `POST /api/images` (image body) | Upload a graphic or mock-up, returns `{id}` |
| `GET /img/:id` | Serve an image |
