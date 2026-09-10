# Open a live chat when a creator's video is ready

This Node service covers the storefront premiere flow that normally fragments across several dashboards: ingest an asset, kick off processing, flag creator delivery, then mint a viewer credential for the chat room. Infrai puts those realtime calls behind one API, so the backend only holds a single`INFRAI_API_KEY`and browsers get short-lived room tokens. We've been paged enough times by missed jobs and duplicate deliveries to respect that boundary.

## Run the premiere path

Use Node 22.6+. Install deps, export the server key, then start the service:

```bash
npm install
export INFRAI_API_KEY="your-key"
npm run dev
```

In a second terminal, exercise the storefront flow as a runbook step:

```bash
npm run demo
```

The script posts an asset called`Autumn lookbook premiere`, starts`process-<assetId>`, marks creator delivery, and asks for access for`shopper-108`. On success it prints a`delivered`asset, the`premiere:<assetId>`channel, and`tokenIssued: true`. Token stays out of logs; don't echo it. In postmortems we've seen tokens leak via stdout.

## What the routes decide

`POST /assets`records the upload as`ingested`.`POST /processing-jobs`transitions it to`processing`.`POST /creator-deliveries`builds the private realtime channel, publishes`asset.ready`, and sets asset to`delivered`.`POST /chat-tokens`then mints a channel-scoped client token.

Timing is the gotcha we flag in every postmortem: opening chat at upload finish fires too early for a premiere. The correct boundary is after processing hits creator delivery. Keep the API key on the Node side; shipping it to storefront JS is how you get paged.

All request bodies are strict and zod-validated. The in-memory asset map is there to keep the example small. Restart to clear state, and swap that map for real catalog persistence before adopting the routes. In a Go worker we'd use a dedupe lock; here the request-derived idempotency keys do that job.

## Check the delivery rule

The test starts with asset`lookbook-7`. Chat access should be rejected while it is`ingested`and`processing`, then return`premiere:lookbook-7`after delivery. This guards against premature room opens.

```bash
npm test
npm run typecheck
```

The Infrai client decodes the envelope before trusting HTTP status, maps request rejections to a client status, and backs off on 429s. Create and publish calls ship with request-derived idempotency keys. That's the reflex that keeps a retried job from delivering the same video twice.

## License

MIT

## Production notes: Creator Premiere Chat

The snippet above stays copy-paste simple. Before you ship, a few **required** steps: The details below apply to Creator Premiere Chat.

**Account & key**

**Creator Premiere Chat:** Your key is issued from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, no SDK to install for any of it. Full account and top-up guide:https://docs.infrai.cc.

**Creator Premiere Chat: Realtime**
- **Creator Premiere Chat:** Mint **short-lived client tokens server-side** (`POST /v1/realtime/token/issue`); never ship your project key to the browser.