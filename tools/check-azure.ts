/** Explicit, read-only smoke check. Secrets are accepted through environment only. */
import { Azure, RequestGate, selectSubscription } from "../server/azure.js";
import { credentialsSchema } from "../shared/validation.js";

const credentials = credentialsSchema.parse(
  JSON.parse(process.env.AZURE_CREDENTIALS_JSON ?? "{}"),
);
const azure = new Azure(new RequestGate(2000));
const subscriptions = await azure.subscriptions(credentials);
console.log(
  JSON.stringify({ appId: credentials.appId, subscriptions }, null, 2),
);
const selected = selectSubscription(subscriptions);
if (process.argv.includes("--inventory")) {
  const account = {
    id: "diagnostic",
    label: "diagnostic",
    ...credentials,
    subscriptionId: selected.subscriptionId,
    subscriptionName: selected.displayName,
    subscriptions,
    state: selected.state,
    lastSync: null,
    createdAt: Date.now(),
    error: null,
  };
  const machines = await azure.machines(credentials, account);
  console.log(
    JSON.stringify(
      {
        machines: machines.map(({ vm }) => ({
          name: vm.name,
          region: vm.location,
          size: vm.size,
          state: vm.powerState,
          publicIpCount: vm.publicIps.length,
        })),
      },
      null,
      2,
    ),
  );
}
