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

## 用户管理

管理员在「设置 → 工作空间成员」可以：

- **改邮箱 / 调角色**：修改后该成员的登录会话立即失效，需要重新登录。
- **重置密码**：设置新密码后，该成员的所有会话立即失效。
- **停用 / 启用**：停用后无法登录，已有会话立即失效。
- **删除用户**：需再次输入其邮箱确认。会一并清除该用户在本地的 Azure 账户、虚拟机缓存、预设、任务与审计记录；**云端资源不会被删除**。

安全约束：不能停用或删除当前登录的管理员账户，也不能删除或降级最后一名管理员，因此不会把工作空间锁死。管理员头像默认取邮箱哈希对应的 Gravatar；如需完全离线可设 `AVATAR_SOURCE=local`。

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
- 规格和 VM 可部署区域缓存 15 分钟；监控和配额缓存 5 分钟；通用实体区域列表缓存 1 小时；镜像目录缓存 24 小时。没有自动扫描云账户。
- 只对 GET 的 429 / 502 / 503 / 504 做有限重试，尊重 `Retry-After`；写请求不自动重试。
- 请求限速能减少不必要的调用，不能保证订阅不受 Azure 自身政策、余额或风控影响。

## 新版已实现

| 功能 | 说明 |
| --- | --- |
| 用户登录 / 退出 / 修改密码 | HttpOnly 会话、CSRF 校验、登录限流 |
| 邀请码注册 | 管理员生成邀请码并开启注册；可设有效期（或永久）与使用次数（或无限）；兑换与建号原子完成，防止并发重复使用 |
| 多用户 | 管理员创建成员；账户和资源按用户隔离 |
| 用户管理 | 管理员可改邮箱、调整角色、重置密码、停用 / 启用、删除；删除前需输入邮箱确认 |
| 邮箱头像 | 默认按邮箱哈希从 Gravatar 获取；`AVATAR_SOURCE=local` 离线用首字母，`none` 关闭 |
| Azure 账户 | JSON 接入、指定订阅、更新密钥、移除本地账户 |
| 资源同步 | 完整分页、VM 状态、网卡、公网和私网 IP；完整读取成功后原子更新缓存 |
| 虚拟机 | 创建、启动、重启、关机、释放、变配、系统盘扩容、更换公网 IPv4/IPv6、普通/强制删除及附属资源清理；当前页显示操作进度 |
| 创建网络 | Standard 静态 IPv4 / IPv6、NSG、VNet、NIC、ARM 部署依赖 |
| 系统镜像 | 区域与镜像从 Azure 读取；实体区域按大洲分组并过滤缺少 VM/托管磁盘/网络支持的区域；创建前重新核验资源区域支持、具体镜像版本、Gen2、x64 与磁盘最小容量 |
| 访问与网络 | RSA SSH 公钥或密码；新建 VM 安全组默认允许所有来源、全部入站端口与协议，双栈时同时放行 IPv6；系统内防火墙需自行管理 |
| 资源组 | 查询、浏览、单个或多选删除；弹窗展示完整资源名称与类型，确认后删除资源组及组内资源，逐项记录结果 |
| AI 模型管理 | Azure OpenAI / AI Services 资源创建、模型目录、部署类型与容量选择、创建和删除模型部署 |
| 订阅额度 | 每个账户显示 Azure 返回的额度、余额范围和本月实际费用；权限不足或接口不支持时明确标注 |
| 规格 / 配额 / 监控 | 按需读取；CPU、网络入站和出站 |
| 预设配置 | 保存常用区域、镜像、规格、系统盘、登录方式与网络设置；一键套用，可设为默认自动加载；含密码时加密存储 |
| 后台任务 / 审计 | 持久化进度、失败信息、重启中断标记 |

**语义说明**：关机 `powerOff` 仍保留分配；`deallocate` 释放计算资源，磁盘与公网 IP 仍可能计费。仅删除 VM 时，磁盘 / 网卡是否保留取决于其 Azure `deleteOption`（面板新建 VM 设置为 Detach）。VM 删除弹窗会实时检查附属资源，对面板创建的独立资源组默认勾选「同时清理附属资源及独立资源组」，展示磁盘、网卡、公网 IPv4/IPv6、VNet、NSG 等完整清单；需额外勾选永久删除资源和数据并输入 VM 名称确认，才能在同一任务中清理整组，不必再去资源浏览器删除。取消勾选则仅删除 VM。强制删除需用户明确勾选，不会绕过权限或资源锁；整组清理时只对 VM 使用 Azure `forceDeletionTypes`，不会自动从普通删除升级为强制删除。系统盘扩容前需停止并释放，扩容后需在操作系统内扩展分区。

自动整组清理要求资源组名称为 `${vm.name}-azpanel`，实时 VM 和资源组均有 `managedBy=azpanel` 标记，清单中没有其他 VM 或无法确认归属的资源，关联磁盘、网卡在当前组内，且未发现共享磁盘、跨组网络或 VNet 对等关联。不能确认时仅允许删除 VM，并解释残留资源可能继续计费。提交和后台执行前重新校验清单及归属；变化后要求重新确认，清理失败会提示检查部分删除结果。最后一次校验与 Azure 接受删除仍非原子操作，请勿并发修改目标资源组。

**入站放行**：创建页不再提供来源 CIDR 或端口配置，新建 NSG 使用 `protocol=*`、来源/目标地址 `*`、来源/目标端口 `*`，对 IPv4 和已启用的 IPv6 放行所有 Azure NSG 支持的入站协议和端口。旧客户端或预设中的 `allowedSource` 字段会被忽略，不会恢复旧规则；这项更改仅影响新建 VM，不修改已有机器，也不关闭操作系统防火墙。全开放会使公开监听的数据库、缓存和管理服务暴露到公网，请自行做好认证、补丁和系统防火墙防护。

**公网 IP 费用**：面板默认创建 Standard 静态公网 IPv4，按保留时间收费，关机/释放 VM 或仅解绑 IP 不会停止收费，需要删除公网 IP 资源。公网 IPv6 地址本身免费，带宽和关联资源另计；选择 IPv4 + IPv6 仍会保留收费的 IPv4。具体价格以当前区域和订阅报价为准：[公网 IP 定价](https://azure.microsoft.com/en-us/pricing/details/ip-addresses/)、[IPv6 费用说明](https://learn.microsoft.com/en-us/azure/virtual-network/ip-services/ipv6-overview#pricing)。

创建页「网络协议」支持 `IPv4`、`IPv4 + IPv6`、`仅公网 IPv6（保留内网 IPv4）` 三种模式。仅公网 IPv6 模式不创建公网 IPv4，也不创建 NAT 网关、负载均衡等收费的 IPv4 出网资源；网卡保留主内网 IPv4 配置，额外关联 Standard 静态公网 IPv6，子网关闭默认出网。**免费的是 IPv6 地址，不是虚拟机、磁盘或全部流量。** 连接端必须支持 IPv6，机器也无法直接访问仅支持 IPv4 的网站、软件源或 API，依赖这些服务的启动脚本、软件安装可能失败。此模式只影响新建资源，不会删除已有机器的公网 IPv4。预设保存公网模式；旧预设/旧 API 请求中缺少 `publicIpv4` 时按 `true` 处理，保留原先 IPv4/双栈行为；`publicIpv4=false` 必须同时设置 `ipv6=true`。

**多个预设**：创建页始终提供「保存为新预设」，即使已经选中预设，也会创建新的独立预设，不覆盖原预设；只有点击「更新当前预设」才会修改已选项。下拉菜单可切换多个预设，网络模式也随预设保存和恢复。可以保存多个普通预设，但默认预设只能有一个，用于进入创建页时自动套用。

### 更换公网 IP

虚拟机列表「管理 → 更换公网 IP」实时列出当前直接绑定网卡的 IPv4/IPv6，选择一个地址并输入 VM 名称确认。只更换已有版本，不会为仅公网 IPv6 机器增加收费 IPv4，也不重建 VM/磁盘。默认勾选「新 IP 切换成功后删除旧公网 IP」，可取消以保留旧地址（保留的 IPv4 仍可能计费）。

后台先创建同区域、同 Standard SKU/可用区、同地址版本的新静态 IP，再重新核对旧 IP 和网卡快照，以条件更新切换单个 IP 配置，保留其他 IP、私网地址、DNS 服务器、NSG、加速网络/IP 转发设置；读取 NIC 和新 IP 双向关联确认成功后才删除已解绑且配置未变的旧 IP。更换会断开现有 SSH/RDP 和业务连接，新 IP 由 Azure 分配，不能指定或保证某个地址/网段；外部 DNS、白名单需自行更新，原 Azure DNS 标签和公网 IP 前缀等特殊设置暂不支持。

新旧 IPv4 短暂并存会占用额外配额并可能计费；配额不足在切换前失败。切换前失败时只清理本次创建且已确认未使用的新 IP，保留旧地址；网卡更新超时或结果不确定时绝不自动删除新旧 IP、不自动重试写操作，任务提供资源名以供核对。新地址生效但旧 IP 删除失败时任务明确提示旧资源可能继续计费，不误报更换失败。更换后的 IP 带 VM 归属标记，可被 VM 删除时的附属资源清理识别。操作期间请勿从 Portal 等客户端并发修改网络配置；地址是否已关联不等于应用层连通性已验证。当前只支持同订阅同资源组内直接绑定 NIC 的区域级 Standard 静态 IP，其他情况请使用 Azure Portal。

## 多选删除与移动端

资源浏览器中点击单组删除，或勾选资源组后点击「删除所选资源组」。弹窗会读取完整分页资源清单，按组展示资源名称与类型；读取失败时不能确认。非空组需要额外勾选「确认永久删除组内全部资源及数据」，再输入单组名称或批量的 `DELETE` 才可提交。每次最多 50 组，同名重复项会被拒绝。取消弹窗不会提交删除。

提交时及后台真正执行前都会重新读取清单、比较与用户看到的清单是否一致；有资源新增、删除或改名时拒绝该项并要求重新确认。任务中心显示每组成功或失败原因，某组失败不阻止其他已确认且清单未变的资源组删除。**确认后会删除整个资源组及组内全部资源，数据不可恢复。** Azure 的列表检查和删除不是原子操作，删除期间请勿在其他客户端修改目标组；检查无法消除最后一次读取和 Azure 接受删除之间的竞争窗口。此前实测记录描述的是当时版本的行为。

成员列表在窄屏上将邮箱、角色状态、操作按钮分行显示，长邮箱省略展示，避免被按钮挤成竖排。

## AI 模型管理

1. 打开「AI 模型」，选择自己的 Azure 账户。
2. 选择已有 Azure OpenAI / AI Services 资源；没有时可点「创建 AI 服务」，在已有资源组中选择区域和服务类型（S0）。订阅需已注册 `Microsoft.CognitiveServices`。
3. 选择账户后先加载服务和部署列表，不等待完整模型目录或配额。服务/验证结果缓存 5 分钟，部署列表缓存 1 分钟，手动刷新可绕过缓存。
4. 点击「部署模型」后才读取模型目录和配额，两者独立加载，配额慢不会阻塞模型选择。目录缓存 1 小时，配额缓存 1 分钟；可单独点击「刷新模型目录」。前端在页面切换、重新打开弹窗时复用缓存，过期后先展示旧数据并后台更新。创建时重新校验版本和容量，不覆盖同名部署。
5. 选择模型、版本、部署类型和容量，输入部署名称确认。操作后留在 AI 页面显示进度，完成后刷新列表；失败直接显示原因。任务中心同时保留记录。
6. 删除模型部署只删除对应 `deployments/{name}`，保留 AI 服务资源。删除后该部署不可继续调用。

AI 缓存同时保存在服务端内存和 SQLite，服务重启后仍可复用有效结果；按账户、订阅及凭据身份隔离，更新密钥后自动使用新缓存，移除账户时级联删除持久化缓存。并发读取/刷新合并为一次加载，云端变更后清理相关部署及配额缓存。浏览器缓存仅保留在内存，登录身份变更或退出时清空。首次加载仍需等待 Azure 响应。

生产构建的带哈希 JS/CSS 静态资源启用一年 immutable 缓存，HTML 每次校验更新；AI 页面按需加载。前端重复 GET 自动合并，任务轮询等待上一轮完成，避免慢连接下叠加请求。

容量预填优先取 Azure `sku.capacity.default`，缺失时回退到 `minimum` 或 1。页面明确标注来源；这是部署容量，不是剩余额度。变更部署类型会重新填入该类型的默认值。

## 创建页区域与镜像校验

区域只保留 Azure `metadata.regionType=Physical` 的实体部署区域，按亚洲、欧洲、北美洲、南美洲、大洋洲、非洲分组；`asia`、`global` 等逻辑区域不会显示，后端也会拒绝将其用于创建。

VM 创建页额外读取当前订阅的 `Microsoft.Compute`、`Microsoft.Network` 资源提供程序元数据，取 VM、托管磁盘、NSG、公网 IP、VNet、NIC 支持区域的交集（兼容 Azure 返回的区域显示名/程序名）。正式创建时重新读取并检查，缺少资源支持时在创建资源组前停止。通用配额和 AI 区域列表不受 VM 专用过滤影响。这不能绕过 Azure 的区域准入、SKU、配额或实时容量限制。

镜像 SKU 和版本目录 API 返回裸数组。创建前通过 `/skus/{sku}/versions` 解析 `latest`，再读取 `/versions/{version}` 检查真实元数据，将解析后的具体版本提交部署。不会再请求无效的 `/skus/{sku}` GET，也不会将目录读取失败伪装成固定镜像列表。

创建虚拟机时留在创建页显示进度，创建并同步成功后自动进入虚拟机管理页并打开新机器详情；失败时留在创建页显示原因并保留配置。跳转使用提交时的账户、资源组和名称定位，不受等待期间表单修改影响，也不跳转任务中心。

创建失败后尝试同步部分资源，便于清理；缺失实例状态、网卡、公网 IP 的 404 不再中断整次 VM 同步，其他权限/网络错误仍拒绝覆盖缓存。删除 VM 成功后立即清理对应本地记录；若其余资源的同步失败，任务明确显示「已删除，其余资源同步失败」，不再误报删除失败。无进度地址的 DELETE 会等待资源实际消失，不会把原来的 `Failed` 部署状态当作删除结果；也不会将操作状态地址的 404 错当资源已删除。

可用 `AZURE_CREDENTIALS_JSON` 环境变量运行 `npx tsx tools/check-image.ts` 只读核验区域、镜像目录和版本详情。`--reproduce-old-url` 可复现旧接口错误。此次只读联调已复现 `The request URL is not valid.` 并验证修正后的路径；未重新创建收费虚拟机。

模型可用性、订阅权限、区域和配额以 Azure 返回为准。容量单位与 TPM 的换算因模型而异；预置吞吐部署可能产生持续费用。面板不自动调用模型、不读取或展示 API 密钥；不支持 Azure ML 托管终结点和第三方服务器的模型部署。AI 部署与删除受 `AZURE_ALLOW_WRITES` 控制，按用户隔离。

## 额度与费用说明

- 进入云账户页会加载每个账号的账单摘要；正常结果持久化缓存 **15 分钟**，临时错误缓存 1 分钟。不会因普通页面刷新持续调用 Azure。
- 额度总额来自 Billing Property 的活动 spending limit；余额来自 Consumption Credit Summary。两者若属于 **账单配置文件共享额度**，页面会明确标注，不能当作某个订阅的独立余额。
- 本月费用来自 Cost Management 的 **MonthToDate / ActualCost / PreTaxCost**，展示 Azure 返回的币种，数据可能延迟。它不是累计已扣赠送额度，也不会用「总额减本月费用」计算余额。
- 部分学生/赞助订阅没有可用的服务主体余额 API；会显示「未提供」及原因，不能将它解读为余额为 0。账单读取需要对应 Billing / Cost Management 权限，Azure 资源 Contributor 不一定拥有这些权限。
- 账单读取失败不影响资源同步。不同用户无法访问对方的账单摘要或 AI 部署。

本次新增功能通过模拟 ARM 的接口测试及浏览器回归验证，未在真实订阅创建付费 AI 部署。接口依据：[AI 模型目录](https://learn.microsoft.com/en-us/rest/api/aiservices/accountmanagement/accounts/list-models?view=rest-aiservices-accountmanagement-2024-10-01)、[AI 部署](https://learn.microsoft.com/en-us/rest/api/aiservices/accountmanagement/deployments/create-or-update?view=rest-aiservices-accountmanagement-2024-10-01)、[Billing Property](https://learn.microsoft.com/en-us/rest/api/billing/billing-property/get?view=rest-billing-2024-04-01)、[Credit Summary](https://learn.microsoft.com/en-us/rest/api/consumption/credits/get?view=rest-consumption-2024-08-01)。

### 功能范围

当前专注于 Azure 核心管理。AWS、自动流控、邮件 / Telegram 通知、账户分享、自动 DNS、历史费用估算和公告管理尚未实现。

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

只有显式设置 `AZURE_LIVE_CONFIRM=create-manage-delete` 才允许创建临时资源；可通过 `AZURE_TEST_REGION` 指定区域，默认为 `eastasia`。脚本的传输层将所有写操作限制到本次随机命名的 `azptest-*` 资源组，并在 finally 中直接调用 ARM 清理这个专用测试组（包含其临时资源），不通过只允许删除空组的网页接口。若清理输出 `CLEANUP_FAILURE`，须检查云端实际状态，不能将超时理解为资源已不存在。

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
