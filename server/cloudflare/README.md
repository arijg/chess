# Deploying the relay to Cloudflare Workers

This is the recommended host: Workers spin up in a few milliseconds (no cold
starts, unlike free Render), and the free plan is plenty for friend games.
The relay is a Worker plus one Durable Object (`Room`) that keeps each game's
two WebSockets together.

You'll do this once. Total time ~5 minutes.

## 0. Prerequisites

- A free Cloudflare account: https://dash.cloudflare.com/sign-up
- Node.js 18+ on your machine (so you can run `wrangler`, Cloudflare's CLI).
  Check with `node --version`; if missing, install from https://nodejs.org
  or `brew install node`.

## 1. Log in to Cloudflare from the CLI

```sh
cd server/cloudflare
npx wrangler login
```

This opens a browser tab — click **Allow**. (`npx wrangler` downloads wrangler
on first use; no global install needed.)

## 2. Deploy

```sh
npx wrangler deploy
```

On success it prints a URL like:

```
https://chess-relay.YOUR-SUBDOMAIN.workers.dev
```

Copy that. (If it's your first Worker, Cloudflare may ask you to pick a
`*.workers.dev` subdomain first — do that, then re-run `deploy`.)

> If deploy complains about Durable Objects needing a plan: this config uses
> `new_sqlite_classes`, which is free-tier eligible. Make sure you didn't
> change it to `new_classes`.

## 3. Point the site at your relay

Open `online.js` (repo root) and set `PROD_RELAY` to your URL with the
**`wss://`** scheme (secure — required because the site is served over HTTPS):

```js
const PROD_RELAY = 'wss://chess-relay.YOUR-SUBDOMAIN.workers.dev';
```

Commit and push; GitHub Pages redeploys and online play is live.

## Test it before committing (optional)

You don't have to edit code to try the deploy. Open the Online page with a
`?relay=` override — it's remembered and baked into the share link you send:

```
https://arijg.github.io/chess/online.html?relay=wss://chess-relay.YOUR-SUBDOMAIN.workers.dev
```

Create a game there, open the generated link in another browser/device, and
play. Once you're happy, set `PROD_RELAY` so plain links work without the
parameter. (To clear a remembered override: `localStorage.removeItem('chess-relay-url')`.)

## Updating later

Re-run `npx wrangler deploy` after any change to `worker.js`. Tail live logs
with `npx wrangler tail`.

## Cost

Free plan: 100k Worker requests/day and a generous Durable Objects allowance.
A WebSocket connection is one request; relayed moves ride the open socket and
don't count as requests. Idle rooms hibernate and cost nothing.
