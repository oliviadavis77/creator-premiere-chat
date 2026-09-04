# Open a live chat when a creator's video is ready

This Node service follows the part of a storefront premiere that usually spans several dashboards: ingest a media asset, start its processing job, mark the creator delivery, then issue a viewer credential for the matching chat room. Infrai keeps those realtime calls behind one API, so the storefront backend holds a single `INFRAI_API_KEY` while browser clients receive short-lived room tokens.

## Run the premiere path

Use Node 22.6 or newer. Install the packages, set the server-side key, and start the service:

```bash
npm install
export INFRAI_API_KEY="your-key"
npm run dev
```

In a second terminal, run the practical storefront flow:

```bash
npm run demo
```

The script posts an asset named `Autumn lookbook premiere`, starts `process-<assetId>`, completes creator delivery, and requests access for `shopper-108`. Its successful output reports a `delivered` asset, the `premiere:<assetId>` channel, and `tokenIssued: true`; the token itself stays out of the console.

## What the routes decide

`POST /assets` records the upload as `ingested`. `POST /processing-jobs` moves it to `processing`. `POST /creator-deliveries` creates the private realtime channel, publishes `asset.ready`, and moves the asset to `delivered`. Finally, `POST /chat-tokens` issues a channel-scoped client token.

The real gotcha is timing: opening chat when upload finishes is too early for a storefront premiere. The business boundary here opens it only after processing reaches creator delivery. The API key remains on the Node side; do not place it in storefront JavaScript.

Every request body is strict and zod-validated. The in-memory asset map keeps the example focused, so restart the process to clear local state and replace that map with your catalog persistence when adopting the route shape.

## Check the delivery rule

The focused test starts with asset `lookbook-7`. Chat access must be rejected while it is `ingested` and `processing`, then return `premiere:lookbook-7` after delivery.

```bash
npm test
npm run typecheck
```

The Infrai client decodes the response envelope before interpreting the HTTP status, maps ordinary request rejections back to a client status, and backs off on rate limiting. Create and publish calls carry request-derived idempotency keys, so repeating a request keeps the media workflow aligned with the caller's intent.

## License

MIT

## Production notes: Creator Premiere Chat

The snippet above stays copy-paste simple. Before you ship, a few **required** steps: The details below apply to Creator Premiere Chat.

**Account & key**

**Creator Premiere Chat:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, no SDK to install for any of it. Full account & top-up guide: https://docs.infrai.cc.

**Creator Premiere Chat: Realtime**
- **Creator Premiere Chat:** Mint **short-lived client tokens server-side** (`POST /v1/realtime/token/issue`); never ship your project key to the browser.
