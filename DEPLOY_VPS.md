# VPS Docker 部署与上线手册

本文用于将博客从本地 Windows 环境部署到 Linux VPS。当前生产方案使用 Docker Compose，并接入 VPS 上已有的 Nginx Proxy Manager（NPM）。执行部署、更新或回滚前，还必须阅读 `ADMIN.md` 和 `BACKUP.md`。

本文不保存真实密码、令牌、密钥或文章内容。所有生产 secret 只允许存在于 VPS 的受限目录，不得提交到公开仓库、写入镜像层或显示在命令输出中。

## 1. 生产架构

```text
访客浏览器
  └─ Cloudflare DNS / Access
       └─ Nginx Proxy Manager :443
            └─ npm-network → linjinmu-blog:8080
                 ├─ 内部 Nginx → /app/runtime/dist
                 └─ /admin-api/* → 127.0.0.1:4322

blog-app
  ├─ Admin API        → 仅监听 127.0.0.1:4322
  ├─ Markdown         → /app/src/content/posts/
  ├─ 自动构建         → /app/runtime/.admin-tmp/ → /app/runtime/dist/
  ├─ 私有文章快照     → GitHub 私有文章仓库
  ├─ 图片上传         → R2 S3 API
  └─ 图库元数据       → /app/server/data/blog.db
```

`blog-app` 与 `blog-web` 共享网络命名空间。这样内部 Nginx 可以访问回环地址上的 Admin API，同时 4322 不会暴露给 NPM、宿主机或公网。

数据边界：

| 内容 | 存放位置 | 是否进入公开框架仓库或镜像 |
| --- | --- | --- |
| 网站框架与 Docker 配置 | GitHub 公开框架仓库 | 是 |
| Markdown 文章 | GitHub 私有文章仓库及 VPS 工作目录 | 否 |
| 图片 | Cloudflare 私有 R2 | 否 |
| 图库元数据 | VPS `server/data/blog.db` | 否 |
| 生产环境变量 | VPS `/srv/linjinmu-blog/secrets/.env` | 否 |
| GitHub Deploy Key | VPS `/srv/linjinmu-blog/secrets/` | 否 |
| 构建产物 | VPS `runtime/dist/` | 否 |

Cloudflare Worker 已独立部署并正常运行时，不要仅因迁移或更新 VPS 而重新部署 Worker。

## 2. 上线前提

- 64 位 Debian 或 Ubuntu VPS。
- Docker Engine 与 Docker Compose v2。
- VPS 上已有 Nginx Proxy Manager；以下示例使用外部网络 `npm-network`。
- Cloudflare 已托管最终域名。
- GitHub 公开框架仓库读取权限。
- GitHub 私有文章仓库的可写 Deploy Key。
- 已部署并绑定 R2、KV 的图片 Worker。
- R2 S3 API 对象读写凭据。

确认环境：

```bash
docker version
docker compose version
git --version
docker network inspect npm-network
```

生产环境不要使用 `npm run dev` 或 `astro preview`。

## 3. 服务用户与目录

容器中的应用进程使用 UID 1000。宿主机创建不可登录的 `blog` 用户，使持久化文件不归 root 所有：

```bash
sudo useradd --system --uid 1000 --create-home --shell /usr/sbin/nologin blog
sudo install -d -m 0755 -o blog -g blog /srv/linjinmu-blog
sudo install -d -m 0700 -o blog -g blog /srv/linjinmu-blog/secrets
```

创建用户前必须用 `getent passwd 1000` 确认 UID 1000 未被占用。如果实际使用其他 UID/GID，必须同步修改 `compose.yaml` 的 `user`、目录所有者和 secret 文件所有者。

生产目录：

```text
/srv/linjinmu-blog/
├─ app/                    公开框架仓库工作树
├─ secrets/
│  ├─ .env                 权限 600
│  ├─ linjinmu_blog_github 权限 600
│  └─ known_hosts          权限 600
└─ rollback/               更新前的 dist 快照
```

## 4. 拉取公开框架

先通过 PR 将已测试代码合并到公开仓库默认分支，再在 VPS 克隆：

```bash
sudo -u blog git clone --branch master --single-branch \
  https://github.com/OWNER/FRAMEWORK_REPOSITORY.git \
  /srv/linjinmu-blog/app
```

先创建由服务用户持有的数据目录，避免 Docker 自动创建为 root：

```bash
cd /srv/linjinmu-blog/app
sudo install -d -m 0755 -o blog -g blog src/content src/content/posts server/data server/backups server/trash runtime
```

应用代码和 `node_modules` 来自镜像，不挂载整个 `/app` 或依赖卷。只挂载上述业务数据目录；文章挂载其父目录 `src/content`，构建产物挂载其父目录 `runtime`，确保暂存与目标位于相同文件系统。Nginx 只读挂载 `runtime`。更新依赖时，重建镜像并重建容器即可使用新依赖。

不得把本地 `node_modules/`、`dist/`、`.env`、文章或数据库复制进公开仓库或 Docker 构建上下文。

## 5. 安装生产 secret

将生产 `.env` 和已经登记到私有文章仓库、具有写权限的 Deploy Key 安全传输到：

```text
/srv/linjinmu-blog/secrets/.env
/srv/linjinmu-blog/secrets/linjinmu_blog_github
```

生成 GitHub SSH 443 主机指纹并设置权限：

```bash
ssh-keyscan -p 443 ssh.github.com \
  > /srv/linjinmu-blog/secrets/known_hosts

sudo chown blog:blog \
  /srv/linjinmu-blog/secrets/.env \
  /srv/linjinmu-blog/secrets/linjinmu_blog_github \
  /srv/linjinmu-blog/secrets/known_hosts

sudo chmod 600 \
  /srv/linjinmu-blog/secrets/.env \
  /srv/linjinmu-blog/secrets/linjinmu_blog_github \
  /srv/linjinmu-blog/secrets/known_hosts
```

禁止读取或打印私钥内容。`.env` 中只记录容器内私钥路径：

```dotenv
CONTENT_GIT_SSH_KEY_PATH=/home/node/.ssh/linjinmu_blog_github
```

## 6. 生产环境变量

生产 `.env` 至少包含：

```dotenv
# Admin
ADMIN_USERNAME=
ADMIN_PASSWORD_HASH=
SESSION_SECRET=
ADMIN_AUTH_DISABLED=false
BLOG_AUTO_BUILD=true

# R2 S3 API
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_PUBLIC_BASE_URL=https://IMAGE_DOMAIN

# Cloudflare；仅在确有需要时填写
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=

# GitHub 私有文章仓库
CONTENT_GIT_ENABLED=true
CONTENT_GIT_REPOSITORY=ssh://git@ssh.github.com:443/OWNER/PRIVATE_CONTENT_REPOSITORY.git
CONTENT_GIT_BRANCH=main
CONTENT_GIT_AUTHOR_NAME=
CONTENT_GIT_AUTHOR_EMAIL=

# SQLite 备份
BLOG_BACKUP_RETENTION_DAYS=14
```

Compose 会强制覆盖以下容器内安全值：

```text
BLOG_ROOT=/app
BLOG_DIST_DIR=/app/runtime/dist
ADMIN_HOST=127.0.0.1
ADMIN_PORT=4322
ADMIN_AUTH_DISABLED=false
CONTENT_GIT_SSH_KEY_PATH=/home/node/.ssh/linjinmu_blog_github
CONTENT_GIT_WORKTREE=/app/server/data/content-repository
BLOG_BACKUP_DIR=/app/server/backups
```

要求：

- `ADMIN_PASSWORD_HASH` 必须由 `npm run hash-password` 生成，不能使用明文密码。
- `SESSION_SECRET` 至少使用 32 字节安全随机值。
- Admin 密码、Session Secret 和 R2 密钥必须使用不同随机值。
- `R2_PUBLIC_BASE_URL` 指向图片 Worker 域名，而不是 R2 公共开发 URL。
- `env_file` 必须使用 Compose 的 `format: raw`，否则密码哈希中的 `$` 可能被错误插值。

## 7. 构建镜像与首次验证

```bash
cd /srv/linjinmu-blog/app
docker compose config --quiet
docker compose build blog-app
```

为回滚保留与 Git 提交对应的镜像标签：

```bash
COMMIT="$(git rev-parse --short HEAD)"
docker tag linjinmu-blog:local "linjinmu-blog:${COMMIT}"
```

运行私有仓库连接测试。该命令不会拉取或推送文章：

```bash
docker compose run --rm blog-app npm run content:git -- test
```

新 VPS 没有未同步文章时，恢复私有文章快照：

```bash
docker compose run --rm blog-app npm run content:git -- pull
```

`pull` 会替换 `src/content/posts/`。如果 VPS 已有尚未同步的文章，必须先备份或推送，不能直接恢复。

随后运行：

```bash
docker compose run --rm blog-app npm test
docker compose run --rm blog-app npm run build:publish
test -f runtime/dist/index.html
```

只有测试和构建全部成功后才能启动生产容器。

## 8. 启动生产容器

```bash
cd /srv/linjinmu-blog/app
docker compose up -d blog-app blog-web
docker compose ps
```

内部验证：

```bash
# NPM 能访问内部 Web 端口
docker exec npm-app curl -I http://linjinmu-blog:8080/

# NPM 不能直接访问 Admin 回环端口；此命令应连接失败
docker exec npm-app curl --connect-timeout 3 http://linjinmu-blog:4322/

# 不得出现宿主机端口绑定
docker inspect linjinmu-blog-app --format '{{json .HostConfig.PortBindings}}'
docker inspect linjinmu-blog-web --format '{{json .HostConfig.PortBindings}}'
```

期望两个 `PortBindings` 都为 `{}`，宿主机 `ss -lntp` 中不得出现 4322 或 8080。

## 9. Nginx Proxy Manager

在 NPM 中创建 Proxy Host：

```text
Domain Names: BLOG_DOMAIN
Scheme: http
Forward Hostname / IP: linjinmu-blog
Forward Port: 8080
```

建议启用：

```text
Block Common Exploits
Websockets Support
```

SSL 页面：

```text
Request a new Certificate
Force SSL: 开
HTTP/2 Support: 开
HSTS Enabled: 初次上线先关闭
HSTS Sub-domains: 关闭
Use DNS Challenge: 通常关闭
```

确认 HTTPS 长期正常后再考虑启用 HSTS。除非根域名下所有子域名都永久支持 HTTPS，否则不要启用 HSTS Sub-domains。

内部 Nginx 必须包含：

```nginx
absolute_redirect off;
```

否则目录跳转可能把 Docker 内部端口 8080 写进公网 URL。

## 10. Cloudflare DNS、SSL 与 Access

DNS 示例：

```text
Type: A
Name: BLOG_SUBDOMAIN
IPv4: VPS_PUBLIC_IP
Proxy status: Proxied
TTL: Auto
```

Cloudflare SSL/TLS 模式使用 `Full (strict)`。

Access 必须保护：

```text
BLOG_DOMAIN/admin
BLOG_DOMAIN/admin/*
BLOG_DOMAIN/admin-api/*
```

策略只允许管理员邮箱。博客自己的密码认证仍保持开启，形成双层保护。只保护页面而遗漏 `/admin-api/*` 属于无效保护。

图片 Worker 的允许来源必须包含：

```text
https://BLOG_DOMAIN
```

## 11. 上线验收

```bash
cd /srv/linjinmu-blog/app
docker compose run --rm blog-app npm test
docker compose run --rm blog-app npm run build:publish
docker compose run --rm blog-app npm run content:git -- test
docker compose ps
curl -I https://BLOG_DOMAIN/
curl -I https://BLOG_DOMAIN/admin/
```

浏览器逐项验证：

1. 首页、文章、归档、摄影和关于页面正常。
2. 当前导航项目具有正确的加粗高亮。
3. 页面跳转不会出现 `:8080`。
4. 移动端字体、滚动、返回动画和暗色模式正常。
5. Cloudflare Access 拦截未授权用户。
6. Admin 可以登录和退出。
7. 发布、修改和删除临时文章后，私有仓库产生对应提交。
8. 上传测试图片后，Worker 返回 `200` 和正确 `Content-Type`。
9. `server/data/blog.db` 正常记录图库元数据。

浏览器如果仍跳转到旧的 `:8080` 地址，先用无痕窗口验证，再清除该域名的旧永久 301 缓存。绝不能因此开放公网 8080。

## 12. SQLite 定时备份

手动备份：

```bash
cd /srv/linjinmu-blog/app
docker compose --profile maintenance run --rm backup
```

备份容器使用 `network_mode: none`，不需要联网。

cron 示例：

```cron
20 3 * * * root cd /srv/linjinmu-blog/app && /usr/bin/docker compose --profile maintenance run --rm backup >> /var/log/linjinmu-blog-backup.log 2>&1
```

安装为 `/etc/cron.d/linjinmu-blog-backup` 时，权限设为 `644`、所有者设为 `root:root`。备份目录不能进入公开 Git 仓库，必要时还应复制到独立备份位置。

## 13. 日常更新

推荐工作流：本地功能分支 → 测试与构建 → PR → 审核合并到 `master` → VPS 更新。不要直接在 VPS 编辑公开框架文件。

更新前先记录当前提交并保留数据库、镜像和 `dist`：

```bash
cd /srv/linjinmu-blog/app
OLD_COMMIT="$(git rev-parse HEAD)"
docker compose --profile maintenance run --rm backup

sudo install -d -m 0750 -o blog -g blog /srv/linjinmu-blog/rollback
sudo cp -a runtime/dist "/srv/linjinmu-blog/rollback/dist-${OLD_COMMIT}"
sudo chown -R blog:blog "/srv/linjinmu-blog/rollback/dist-${OLD_COMMIT}"
```

拉取并在切换容器前验证：

```bash
git pull --ff-only
docker compose build blog-app
docker compose run --rm blog-app npm run content:git -- test
docker compose run --rm blog-app npm test
docker compose run --rm blog-app npm run build:publish
```

保留新镜像标签并切换：

```bash
NEW_COMMIT="$(git rev-parse --short HEAD)"
docker tag linjinmu-blog:local "linjinmu-blog:${NEW_COMMIT}"
docker compose up -d --force-recreate blog-app blog-web
docker compose ps
```

只有 Worker 代码或绑定发生变化时才部署 Worker。普通博客框架更新不要重复部署 Worker。

### 从旧版整仓挂载升级

旧版产物位于宿主机 `dist/`，新配置使用 `runtime/dist/`。第一次升级前先备份 SQLite、文章和旧 dist，记录旧提交及旧镜像标签。创建上文的数据目录后，在新镜像内运行测试和 `npm run build:publish`，检查 `runtime/dist/index.html` 存在，再重建两个服务。此时旧容器仍使用旧的 `dist/`；旧目录和旧依赖卷暂时保留，验收成功前不要删除。升级期间暂停后台写入，避免测试构建与正在发布的文章互相干扰。

新挂载配置的代码来自镜像，回滚需使用对应旧镜像及该版本的 Compose/Nginx 配置。回滚到整仓挂载版本时恢复宿主机 `dist/`，不要误将新路径套用到旧配置。

## 14. 回滚

回滚前先备份当前 SQLite：

```bash
cd /srv/linjinmu-blog/app
docker compose --profile maintenance run --rm backup
git rev-parse HEAD
```

切换到已知可用提交：

```bash
docker compose stop blog-app blog-web
git switch --detach KNOWN_GOOD_COMMIT
docker compose build blog-app
docker compose run --rm blog-app npm test
docker compose run --rm blog-app npm run build:publish
docker compose up -d --force-recreate blog-app blog-web
```

如果新构建失败，可将 `/srv/linjinmu-blog/rollback/dist-KNOWN_GOOD_COMMIT` 恢复为 `runtime/dist`，并使用保留的 `linjinmu-blog:KNOWN_GOOD_SHORT_COMMIT` 镜像。不要使用 `git reset --hard`。

恢复文章前先复制当前 `src/content/posts/`，再运行 `content:git -- pull`。恢复 SQLite 时先停止 `blog-app`，替换 `server/data/blog.db`，确认所有者为 `blog` 后再启动。

## 15. 安全检查

提交或部署前：

```bash
git ls-files -- .env '.env.*' 'src/content/posts/*' 'server/data/*' 'server/backups/*'
git status --short
```

预期只可能看到安全的 `.env.example` 和用于保留空目录的 `.gitkeep`。不得出现真实文章、数据库、生产 `.env`、SSH 私钥或备份。

生产要求：

- `.env`、Deploy Key 和 `known_hosts` 权限为 `600`。
- Admin 强制监听 `127.0.0.1:4322`。
- 4322 和 8080 均不映射到宿主机。
- 应用容器使用非 root UID。
- 容器启用 `no-new-privileges` 并移除不需要的 capabilities。
- 内部 Nginx 根文件系统保持只读，临时目录使用 tmpfs。
- Cloudflare Access 与博客密码认证同时启用。
- 不在命令输出、日志、截图、镜像层或 AI 对话中暴露 secret。

## 16. 给部署 AI 的启动提示词

```text
你正在用 Docker Compose 将博客部署或更新到 Linux VPS。
先完整阅读 AGENTS.md、DEPLOY_VPS.md、ADMIN.md 和 BACKUP.md。
在执行写操作前，只读检查 Docker、Compose、npm-network、现有容器、目录、端口、DNS 和 NPM 代理。
不得输出、提交或复制展示任何密码、令牌、R2 凭据、Session Secret 或 SSH 私钥内容。
公开框架、私有文章仓库、R2 图片和 blog.db 必须保持分离。
每次生产变更前都先备份 SQLite、记录当前提交并保存旧 dist；测试与构建成功后才切换容器。
Admin 必须只监听容器回环地址 127.0.0.1:4322，4322 和 8080 不得映射到宿主机。
不得使用 git reset --hard。发生错误时保留当前健康容器和数据，并报告阻塞点。
```
