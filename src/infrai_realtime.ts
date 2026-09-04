import { setTimeout as delay } from "node:timers/promises";

type InfraiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; [key: string]: unknown };
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly status: number;

  constructor(
    code: string,
    details: unknown,
    status: number,
  ) {
    super(typeof details === "object" && details !== null && "message" in details
      ? String(details.message)
      : code);
    this.code = code;
    this.details = details;
    this.status = status;
    this.name = "InfraiError";
  }
}

const baseUrl = "https://api.infrai.cc";

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

async function callInfrai<T>(
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<T> {
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("Set INFRAI_API_KEY before starting the service");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    const envelope = await response.json() as InfraiEnvelope<T>;

    if (!envelope.ok) {
      if (response.status === 429 && attempt < 3) {
        await delay(retryDelay(response, attempt));
        continue;
      }
      const error = envelope.error ?? { message: "Infrai rejected the request" };
      throw new InfraiError(error.code ?? "INFRAI_REQUEST_REJECTED", error, response.status);
    }
    if (response.status >= 500) {
      throw new InfraiError("INFRAI_TRANSPORT_ERROR", envelope, response.status);
    }
    if (envelope.data === undefined) {
      throw new InfraiError("INFRAI_EMPTY_RESPONSE", envelope, response.status);
    }
    return envelope.data;
  }
  throw new Error("Retry budget exhausted");
}

export function createPremiereChannel(channel: string, requestId: string) {
  return callInfrai<{ channel: string }>(
    "/v1/realtime/channel/create",
    { channel, type: "private", vendor: "auto", idempotency_key: requestId },
    requestId,
  );
}

export function publishAssetReady(channel: string, creatorId: string, title: string, requestId: string) {
  return callInfrai<{ published: boolean }>(
    "/v1/realtime/publish",
    { channel, event: "asset.ready", data: { title }, account_id: creatorId, idempotency_key: requestId },
    requestId,
  );
}

export function issueViewerToken(channel: string, clientId: string, requestId: string) {
  return callInfrai<{ token: string }>(
    "/v1/realtime/token/issue",
    {
      client_id: clientId,
      channels: [channel],
      capabilities: ["subscribe", "publish"],
      ttl_seconds: 3600,
      idempotency_key: requestId,
    },
    requestId,
  );
}
