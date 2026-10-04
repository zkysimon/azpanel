/** Read-only verification of the regional VM image APIs. Never provisions resources. */
import { Azure, RequestGate } from "../server/azure.js";
import { credentialsSchema } from "../shared/validation.js";
import type { Account } from "../shared/types.js";

const credentials = credentialsSchema.parse(
  JSON.parse(process.env.AZURE_CREDENTIALS_JSON ?? "{}"),
);
const azure = new Azure(new RequestGate(2000));
const subscriptions = await azure.subscriptions(credentials);
const subscription = subscriptions.find((item) => item.state === "Enabled");
if (!subscription) throw new Error("No enabled subscription");
const account: Account = {
  id: "read-only-image-check",
  label: "read-only",
  appId: credentials.appId,
  tenant: credentials.tenant,
  subscriptionId: subscription.subscriptionId,
  subscriptionName: subscription.displayName,
  state: subscription.state,
  subscriptions,
  lastSync: null,
  createdAt: Date.now(),
  error: null,
};
const locations = await azure.locations(credentials, account);
console.log("Physical regions:", locations.length, "Groups:", [
  ...new Set(locations.map((item) => item.continent)),
]);
const region =
  locations.find((item) => item.name === "eastasia") ?? locations[0];
if (!region) throw new Error("No physical deployment region");
const image = {
  publisher: "Canonical",
  offer: "ubuntu-24_04-lts",
  sku: "server",
  version: "latest",
};
const root = `/subscriptions/${account.subscriptionId}/providers/Microsoft.Compute/locations/${region.name}/publishers/Canonical/artifacttypes/vmimage/offers/ubuntu-24_04-lts/skus`;
if (process.argv.includes("--reproduce-old-url")) {
  try {
    await azure.request(
      credentials,
      "GET",
      `${root}/server?api-version=2024-11-01`,
    );
    console.log("Old SKU URL unexpectedly accepted");
  } catch (error) {
    console.log("Old SKU URL:", (error as Error).message);
  }
}
const { data: skus } = await azure.request(
  credentials,
  "GET",
  `${root}?api-version=2024-11-01`,
);
console.log("Image SKUs response is a bare array:", Array.isArray(skus));
const resolved = await azure.assertImageAvailable(
  credentials,
  account,
  region.name,
  image,
);
console.log(
  JSON.stringify({
    region: region.name,
    image: resolved.reference,
    generation: resolved.properties.hyperVGeneration,
    architecture: resolved.properties.architecture,
    diskGiB: resolved.properties.osDiskImage.sizeInGb,
  }),
);
