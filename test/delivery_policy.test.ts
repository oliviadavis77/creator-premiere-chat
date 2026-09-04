import assert from "node:assert/strict";
import test from "node:test";
import {
  DeliveryConflict,
  markDelivered,
  requirePremiereChannel,
  startProcessing,
  type MediaAsset,
} from "../src/delivery_policy.ts";

test("viewer chat opens only after processing reaches creator delivery", () => {
  const ingested: MediaAsset = {
    assetId: "lookbook-7",
    creatorId: "creator-42",
    title: "Autumn lookbook premiere",
    status: "ingested",
  };

  assert.throws(() => requirePremiereChannel(ingested), DeliveryConflict);
  const processing = startProcessing(ingested);
  assert.throws(() => requirePremiereChannel(processing), DeliveryConflict);
  const delivered = markDelivered(processing, "premiere:lookbook-7");
  assert.equal(requirePremiereChannel(delivered), "premiere:lookbook-7");
});
