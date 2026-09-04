export type AssetStatus = "ingested" | "processing" | "delivered";

export type MediaAsset = {
  assetId: string;
  creatorId: string;
  title: string;
  status: AssetStatus;
  channel?: string;
};

export class DeliveryConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryConflict";
  }
}

export function startProcessing(asset: MediaAsset): MediaAsset {
  if (asset.status !== "ingested") {
    throw new DeliveryConflict("Only an ingested asset can start processing");
  }
  return { ...asset, status: "processing" };
}

export function markDelivered(asset: MediaAsset, channel: string): MediaAsset {
  if (asset.status !== "processing") {
    throw new DeliveryConflict("The processing job must be active before creator delivery");
  }
  return { ...asset, status: "delivered", channel };
}

export function requirePremiereChannel(asset: MediaAsset): string {
  if (asset.status !== "delivered" || !asset.channel) {
    throw new DeliveryConflict("Chat opens after the processed asset reaches creator delivery");
  }
  return asset.channel;
}
