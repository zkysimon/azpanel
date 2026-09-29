# azpanel 2.0

基于 **TypeScript + React + Fastify** 的 Azure 云资源管理面板。Material Design 3 风格，支持浅色 / 深色主题、桌面与移动端。

## 技术栈

- **前端**：React 19、TypeScript、Vite、MUI（MD3 主题）、Lucide 图标、Recharts。
- **后端**：Node.js 22.13+、Fastify、Azure Identity SDK、Azure Resource Manager REST API。
- **数据**：SQLite（Node 内置驱动），凭据使用 AES-256-GCM 加密；会话令牌仅保存哈希。
- **任务**：单进程串行队列、持久化进度及审计；服务重启后的未完成任务标记为 interrupted，不自动重放云端写操作。

仓库仅包含 TypeScript / React 版本，运行时使用 Node.js 和 SQLite。

## 本地启动

要求 Node.js **22.13 或更高版本**（推荐最新 Node 22 LTS）。该版本的内置 SQLite 可能显示实验性提示。

```sh
npm ci
npm run setup
npm run dev
```

`setup` 会询问管理员邮箱，生成加密密钥、随机初始密码和 `.env.node`。它不会覆盖已有配置。打开 **http://127.0.0.1:5173**，使用生成的账号登录。

也可手动将 `.env.node.example` 复制为 `.env.node`，填写 `ENCRYPTION_KEY`、`ADMIN_EMAIL` 和 `ADMIN_PASSWORD`。管理员只会在空数据库首次启动时创建；之后修改环境变量不会重置现有密码。

### 生产运行

上传服务器时保留以下文件和目录（包括隐藏的配置示例文件）：

```text
client/  server/  shared/  tools/  tests/  docs/
package.json  package-lock.json
tsconfig.json  tsconfig.server.json  vite.config.ts  playwright.config.ts
Dockerfile  compose.yaml  .dockerignore  .env.node.example
README.md  LICENSE.txt  .gitignore
```

本机的 `node_modules/`、`dist/`、`test-results/`、`playwright-report/`、`.git/` 无需上传。在服务器上安装依赖和构建，避免跨平台依赖问题。首次部署使用 `npm run setup` 生成服务器自己的 `.env.node`；更新部署时保留现有 `.env.node` 和 `data/`。

```sh
npm ci
npm run setup  # 仅首次部署
npm run build
npm start
```

Node 服务在 **http://127.0.0.1:3000** 同时提供 API 和构建后的网页。生产环境建议通过 HTTPS 反向代理访问，并设置 `COOKIE_SECURE=true`。反向代理需保留原始 `Host`，以便同源校验正常工作。

常驻运行及反向代理配置见 [服务器部署说明](docs/deployment.md)。

### Docker

先生成 `.env.node`，然后：

```sh
docker compose up -d --build
```

数据保存在命名卷 `azpanel-data`。停止服务后备份整个数据卷及 `.env.node`。**加密密钥丢失后无法恢复 Azure 凭据。** 同一数据库目前只支持一个应用实例；不要部署多个副本共享 SQLite。

## 邀请码注册

默认**关闭**公开注册。需要时由管理员在「设置 → 注册邀请码」：

1. 点击 **生成邀请码**，可设置备注、使用次数上限（`0` 为不限）、有效期（可选永久）。
2. 生成后复制形如 `ABCD-EFGH-JKLM-NPQR` 的邀请码发给用户。
3. 点击 **开放注册**。

受邀用户在登录页点「使用邀请码注册」，填写邮箱、密码和邀请码即可创建账户。关闭注册后，注册接口返回 403；邀请码过期或用尽会被拒绝。邀请码兑换与创建账户在同一数据库事务内完成，避免并发下超用。

## 接入 Azure

1. 登录面板，进入 **云账户 → 接入账户**。
2. 粘贴服务主体 JSON（`appId`、`password`、`tenant`）。账户名称默认取 `displayName`。
3. 可指定订阅 ID；留空选择第一个 Enabled 订阅。
4. 接入后手动点击 **同步资源**，任务中心显示同步进度。

读取资源需要订阅范围的 Reader 权限，创建 / 管理需要 Contributor 等相应权限。能获取令牌并不代表能看到订阅；空订阅列表会显示明确错误。

### 低频访问与云端写操作

- 默认 `AZURE_ALLOW_WRITES=false`，服务端阻止创建、开关机、变配和删除。
- 确认需要管理后设为 `true` 并重启。网页变更操作需再次输入资源名称。
- 全局 Azure 请求串行执行，默认每次请求完成后间隔 1.5 秒；最低 1 秒。
- 同一账户同一时刻只能运行一个任务，成功同步后的 60 秒内不可重复同步。
- 规格缓存 15 分钟；监控和配额缓存 5 分钟；区域列表缓存 1 小时；镜像目录缓存 24 小时。没有自动扫描云账户。
- 只对 GET 的 429 / 502 / 503 / 504 做有限重试，尊重 `Retry-After`；写请求不自动重试。
- 请求限速能减少不必要的调用，不能保证订阅不受 Azure 自身政策、余额或风控影响。

## 新版已实现

| 功能 | 说明 |
| --- | --- |
| 用户登录 / 退出 / 修改密码 | HttpOnly 会话、CSRF 校验、登录限流 |
| 邀请码注册 | 管理员生成邀请码并开启注册；可设有效期（或永久）与使用次数（或无限）；兑换与建号原子完成，防止并发重复使用 |
| 多用户 | 管理员创建成员；账户和资源按用户隔离 |
| Azure 账户 | JSON 接入、指定订阅、更新密钥、移除本地账户 |
| 资源同步 | 完整分页、VM 状态、网卡、公网和私网 IP；完整读取成功后原子更新缓存 |
| 虚拟机 | 创建、启动、重启、关机、释放、变配、系统盘扩容、删除 |
| 创建网络 | Standard 静态 IPv4 / IPv6、NSG、VNet、NIC、ARM 部署依赖 |
| 系统镜像 | 区域与镜像均从 Azure 实时读取（区域缓存 1 小时、镜像缓存 24 小时），Gen2 x64 过滤；覆盖 Ubuntu、Debian、AlmaLinux、Rocky Linux、Oracle Linux 与 Windows Server |
| 访问控制 | RSA SSH 公钥或密码；指定管理来源 CIDR，仅开放 SSH / RDP |
| 资源组 | 查询、浏览、删除（明确确认，删除组内所有资源） |
| 规格 / 配额 / 监控 | 按需读取；CPU、网络入站和出站 |
| 预设配置 | 保存常用区域、镜像、规格、系统盘、登录方式与网络设置；一键套用，可设为默认自动加载；含密码时加密存储 |
| 后台任务 / 审计 | 持久化进度、失败信息、重启中断标记 |

**语义说明**：关机 `powerOff` 仍保留分配；`deallocate` 释放计算资源，磁盘与公网 IP 仍可能计费。删除现有 VM 是否自动删除磁盘 / 网卡取决于其 Azure `deleteOption`。新版新建 VM 设置为 Detach；要清理整个部署，请确认后删除对应资源组。系统盘扩容前需停止并释放，扩容后需在操作系统内扩展分区。

### 功能范围

当前专注于 Azure 核心管理。AWS、自动流控、邮件 / Telegram 通知、账户分享、自动 DNS、换公网 IP、历史费用估算和公告管理尚未实现。

## 验证

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

浏览器测试使用独立内存数据库和模拟 Azure，不访问真实账号。Windows 默认使用已安装的 Edge；其他平台使用 `npx playwright install chromium` 安装 Chromium。

可显式执行真实只读诊断，凭据通过 `AZURE_CREDENTIALS_JSON` 环境变量提供：

```sh
npm run check:azure
npm run check:azure -- --inventory
```

不要把实际密钥写入源码或测试夹具。诊断只读取订阅和可选的 VM / 网卡 / IP 清单，不创建或修改资源。

### 本次验证范围

- 新账号：成功认证，读取到 Enabled 的 Azure for Students 订阅及运行中的现有 VM。
- 前两个账号：认证成功，订阅列表为空。
- 经用户明确授权，已在真实 Azure for Students 订阅上完成临时 VM 创建、同步、重启、停止释放、启动，以及资源组删除；最终确认无临时资源遗留，原有 VM 保持运行。
- 此次实测修复 Ubuntu 24.04 镜像 SKU（应为 `server`），并补齐读取及轮询时的有限网络重试。写请求仍不自动重试。
- 监控接口成功返回，但新建 VM 尚无 CPU 采样；未实测 SSH 登录、变配、扩容、IPv6 或 Windows 创建。
- 桌面 / 手机布局、登录、导航、主题切换、账户输入校验、详情和配额查询经过浏览器回归。

### 可选真实生命周期测试

`tools/live-lifecycle.ts` 使用独立内存数据库，凭据仍从 `AZURE_CREDENTIALS_JSON` 环境变量传入。普通 `npm test` 不会触发它。

```sh
npx tsx tools/live-lifecycle.ts --preflight
```

只有显式设置 `AZURE_LIVE_CONFIRM=create-manage-delete` 才允许创建临时资源；可通过 `AZURE_TEST_REGION` 指定区域，默认为 `eastasia`。脚本的传输层将所有写操作限制到本次随机命名的 `azptest-*` 资源组，并在 finally 中尝试删除。若清理输出 `CLEANUP_FAILURE`，须检查云端实际状态，不能将超时理解为资源已不存在。

详细实测记录见 [docs/live-test-2026-09-28.md](docs/live-test-2026-09-28.md)。

## 项目结构

```text
client/       React 界面、MD3 主题与样式
server/       Fastify API、会话、加密存储、Azure 适配、任务队列
shared/       共享类型与 Zod 输入校验
tests/        接口回归、ARM 模拟、浏览器测试
tools/        初始化、只读诊断和可选真实生命周期测试
docs/         服务器部署说明和测试记录
```

项目主页：[zkysimon/azpanel](https://github.com/zkysimon/azpanel) · 原项目上游：[azpanel/azpanel](https://github.com/azpanel/azpanel) · 开源协议见 [LICENSE.txt](LICENSE.txt)。
