import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

if (existsSync(".env.node"))
  throw new Error(".env.node 已存在，未覆盖。请直接编辑现有配置。");
const prompt = createInterface({ input: stdin, output: stdout });
try {
  const email = (await prompt.question("管理员邮箱：")).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new Error("邮箱格式无效");
  const password = randomBytes(18).toString("base64url");
  writeFileSync(
    ".env.node",
    [
      `ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`,
      "DATA_DIR=./data",
      "HOST=127.0.0.1",
      "PORT=3000",
      `ADMIN_EMAIL=${email}`,
      `ADMIN_PASSWORD=${password}`,
      "AZURE_ALLOW_WRITES=false",
      "COOKIE_SECURE=false",
      "AZURE_REQUEST_INTERVAL_MS=1500",
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    `配置已生成。管理员邮箱：${email}\n初始密码：${password}\n请保存密码，然后运行 npm run dev。`,
  );
} finally {
  prompt.close();
}
