# 服务器部署

## 1. 上传与初始化

环境要求：Node.js **22.13+**，推荐最新 Node 22 LTS。无需额外安装数据库服务。

将 README 的上传清单复制到服务器，例如 `/opt/azpanel`。不要上传本机 `node_modules/`、`dist/` 或测试报告。在项目目录执行：

```sh
npm ci
npm run setup
npm run build
npm start
```

`setup` 生成 `.env.node`，并显示随机管理员密码。`.env.node` 与 `data/` 必须保留；更新版本时不覆盖它们。

本地检查：

```sh
curl http://127.0.0.1:3000/api/health
```

返回 `{"status":"ok","version":"2.0.0"}` 表示服务已启动。`npm start` 在前台运行；常驻运行可以使用下面的 systemd 或已有的 Docker Compose 配置。

## 2. Linux systemd 常驻运行

以下示例假设项目位于 `/opt/azpanel`、Node 在 `/usr/bin/node`，运行用户为 `azpanel`。先用 `command -v node` 确认实际 Node 路径，并确保该用户可以读取项目和 `.env.node`、写入 `data/`。

创建 `/etc/systemd/system/azpanel.service`：

```ini
[Unit]
Description=azpanel Azure management console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=azpanel
Group=azpanel
WorkingDirectory=/opt/azpanel
ExecStart=/usr/bin/node /opt/azpanel/dist/server/index.js
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5
TimeoutStopSec=720
UMask=0077

[Install]
WantedBy=multi-user.target
```

Node 会从工作目录加载 `.env.node`。用 root 或 sudo 创建运行用户、设置目录权限并启动服务：

```sh
sudo useradd --system --user-group --home-dir /opt/azpanel --shell /usr/sbin/nologin azpanel
sudo chown -R azpanel:azpanel /opt/azpanel
sudo chmod 600 /opt/azpanel/.env.node
sudo systemctl daemon-reload
sudo systemctl enable --now azpanel
sudo journalctl -u azpanel -n 50
```

已存在运行用户时跳过 `useradd`。配置中的 12 分钟停止等待用于给正在执行的 Azure 任务留出退出时间。

## 3. 反向代理

在 Nginx / 宝塔的 HTTPS 站点中，将站点反向代理到 `http://127.0.0.1:3000`。应用自己提供网页和 API，不需要单独指定静态网站目录。

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 10s;
    proxy_read_timeout 300s;
}
```

保留原始 Host，否则登录和其他写请求的同源校验会失败。配置好 HTTPS 后，将 `.env.node` 的 `COOKIE_SECURE` 改为 `true` 并重启。仅通过 HTTP 本地测试时保持 `false`。

## 4. Docker Compose

如果使用 Docker，在项目目录准备好 `.env.node` 后执行：

```sh
docker compose up -d --build
docker compose logs --tail=50
```

镜像会自行安装 Node 依赖并构建。`.env.node` 可手动从 `.env.node.example` 复制并填写；`ENCRYPTION_KEY` 必须是 64 位十六进制随机值，管理员密码至少 12 位。未安装本机 Node 时，可用以下命令生成随机值：

```sh
openssl rand -hex 32
```

容器仅发布到服务器的 `127.0.0.1:3000`，通过前面的反向代理对外提供访问。数据使用 `azpanel-data` 命名卷，而不是项目下的 `data/`。

## 5. 云端管理与升级

- 默认 `AZURE_ALLOW_WRITES=false`。需要创建、开关机、变配或删除时，设为 `true` 并重启服务。
- 日常启动、构建和 `npm test` 不会执行真实云资源测试。
- 升级先停止服务并备份 `.env.node` 及数据库，再覆盖代码、运行 `npm ci && npm run build`、重新启动。
- Docker 升级保留命名卷及 `.env.node`；不要使用 `docker compose down -v` 删除数据卷。
- 使用单个服务实例；不要让多个进程共享同一 SQLite 文件。备份数据库时停止服务，并连同 WAL 等文件一起备份整个数据目录。
