# BBI Merch

Merch stock and sales tracker for Bastard Bearded Irishmen, built to run on a phone at the merch table.

## What it does

- **Stock:** add a design with its graphic and mock-up photo, the styles it comes in (T-shirt, hoodie, CD...), a price per style (with optional per-size prices), and a count for each size. Sizes at 3 or fewer show as low, 0 as sold out.
- **Sell:** tap an item, tap sizes to build a sale, then tap Cash or Card to record it. Stock goes down automatically, today's sales are listed with totals, and any sale can be undone.
- **No signal:** sales recorded while offline are kept on the phone and sync once the connection comes back. The page has to be opened while there is signal and left open.

## How it runs

`app/bbi-merch-tracker.html` is a single page published as a Claude artifact. It uses the artifact runtime (`window.claude.use(...)`) for:

- `db`: shared data store
  - `designs/{id}`: `{name, graphic, mockup, createdAt, updatedAt, lastSaleIds, styles: [{id, name, price, mockup, sizes: [{size, stock, price?}]}]}`
  - `sales/{id}`: `{at, items: [{designId, designName, styleId, styleName, size, qty, price}], total, payment}`
- `assets`: uploaded graphics and mock-ups (stored as asset ids, served from `/_blob/<id>`)
- `user`: checks whether the viewer can edit

Because of that runtime it only works when opened as the published artifact, not as a plain file or on other hosting.
