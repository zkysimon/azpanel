import { configuration } from "./config.js";
import { buildApp } from "./app.js";

const config = configuration();
const { app } = await buildApp(config);
await app.listen({ host: config.host, port: config.port });
console.log(
  `azpanel http://${config.host}:${config.port} · cloud writes ${config.writesEnabled ? "enabled" : "disabled"}`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
