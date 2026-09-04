import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DeliveryConflict,
  markDelivered,
  requirePremiereChannel,
  startProcessing,
  type MediaAsset,
} from "./delivery_policy.ts";
import {
  createPremiereChannel,
  InfraiError,
  issueViewerToken,
  publishAssetReady,
} from "./infrai_realtime.ts";

const assets = new Map<string, MediaAsset>();
const ingestBody = z.object({ assetId: z.string().min(1), creatorId: z.string().min(1), title: z.string().min(1) }).strict();
const jobBody = z.object({ assetId: z.string().min(1) }).strict();
const deliveryBody = z.object({ assetId: z.string().min(1) }).strict();
const tokenBody = z.object({ assetId: z.string().min(1), clientId: z.string().min(1) }).strict();

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function getAsset(assetId: string): MediaAsset {
  const asset = assets.get(assetId);
  if (!asset) throw new DeliveryConflict("Asset was not ingested");
  return asset;
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST") {
    json(response, 404, { error: "Route not found" });
    return;
  }

  const requestId = String(request.headers["x-request-id"] ?? randomUUID());
  const body = await readJson(request);

  if (request.url === "/assets") {
    const input = ingestBody.parse(body);
    const asset: MediaAsset = {
      assetId: input.assetId,
      creatorId: input.creatorId,
      title: input.title,
      status: "ingested",
    };
    assets.set(asset.assetId, asset);
    json(response, 201, asset);
    return;
  }
  if (request.url === "/processing-jobs") {
    const input = jobBody.parse(body);
    const asset = startProcessing(getAsset(input.assetId));
    assets.set(asset.assetId, asset);
    json(response, 202, { jobId: `process-${asset.assetId}`, asset });
    return;
  }
  if (request.url === "/creator-deliveries") {
    const input = deliveryBody.parse(body);
    const asset = getAsset(input.assetId);
    const channel = `premiere:${asset.assetId}`;
    await createPremiereChannel(channel, `${requestId}:channel`);
    await publishAssetReady(channel, asset.creatorId, asset.title, `${requestId}:ready`);
    const delivered = markDelivered(asset, channel);
    assets.set(asset.assetId, delivered);
    json(response, 200, delivered);
    return;
  }
  if (request.url === "/chat-tokens") {
    const input = tokenBody.parse(body);
    const channel = requirePremiereChannel(getAsset(input.assetId));
    const token = await issueViewerToken(channel, input.clientId, `${requestId}:token`);
    json(response, 200, { channel, ...token });
    return;
  }
  json(response, 404, { error: "Route not found" });
}

export const server = createServer((request, response) => {
  route(request, response).catch((error: unknown) => {
    if (error instanceof z.ZodError) {
      json(response, 400, { error: "Invalid request body", issues: error.issues });
    } else if (error instanceof DeliveryConflict) {
      json(response, 409, { error: error.message });
    } else if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      json(response, status, { error: error.message, code: error.code });
    } else {
      json(response, 500, { error: "Request could not be completed" });
    }
  });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => console.log(`Premiere service listening on http://localhost:${port}`));
}
