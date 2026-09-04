const serviceUrl = process.env.SERVICE_URL ?? "http://localhost:3000";
const assetId = `lookbook-${Date.now()}`;

export {};

async function post(path: string, body: unknown) {
  const response = await fetch(`${serviceUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": `demo-${assetId}-${path}` },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}

await post("/assets", { assetId, creatorId: "creator-42", title: "Autumn lookbook premiere" });
await post("/processing-jobs", { assetId });
const delivery = await post("/creator-deliveries", { assetId });
const access = await post("/chat-tokens", { assetId, clientId: "shopper-108" });

console.log(JSON.stringify({ delivery, access: { channel: access.channel, tokenIssued: Boolean(access.token) } }, null, 2));
