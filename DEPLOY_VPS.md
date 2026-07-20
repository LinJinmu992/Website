# VPS 迁移与上线手册

本文用于让人工或 AI 将博客从本地 Windows 环境迁移到 Linux VPS。执行迁移前还必须阅读 `ADMIN.md` 和 `BACKUP.md`。

本文不会保存真实密码、令牌、密钥或文章内容。所有占位符都必须在 VPS 本地替换，不能提交到公开仓库。

## 1. 架构与数据边界

```text
访客浏览器
  ├─ 博客 HTML/CSS/JS → Nginx → dist/
  ├─ /admin-api/*     → Nginx → 127.0.0.1:4322
  └─ 图片             → Cloudflare Worker → 私有 R2

Admin
  ├─ Markdown         → src/content/posts/
  ├─ 自动构建         → 临时目录 → dist/
  ├─ 文章快照         → GitHub 私有文章仓库
  ├─ 图片上传         → R2 S3 API
  └─ 图库元数据       → server/data/blog.db
```

数据分别存放：

| 内容 | 存放位置 | 是否进入公开框架仓库 |
| --- | --- | --- |
| 网站框架 | GitHub 公开框架仓库 | 是 |
| Markdown 文章 | GitHub 私有文章仓库的 `posts/` | 否 |
| 图片 | Cloudflare R2 | 否 |
| 图库元数据 | VPS `server/data/blog.db` | 否 |
| 环境变量 | VPS 项目根目录 `.env` | 否 |
| SSH 私钥 | VPS 服务用户的 `.ssh/` | 否 |

Cloudflare Worker 已独立部署时，不需要因为迁移博客 VPS 而重新部署 Worker。

## 2. 上线前提

- 64 位 Linux VPS，建议 Debian 或 Ubuntu 的受支持版本。
- Node.js `>=22.16.0`，以 `package.json` 的 `engines` 为最终依据。
- Git、Nginx、systemd 和有效 HTTPS 域名。
- Cloudflare DNS 已托管最终域名。
- GitHub 公开框架仓库读取权限。
- GitHub 私有文章仓库的可写 Deploy Key。
- 已部署并绑定 R2、KV 的 Cloudflare Worker。
- R2 S3 API 的对象读写凭据。

先确认版本：

```bash
node --version
npm --version
git --version
nginx -v
```

不要在生产环境使用 `npm run dev` 或 `astro preview`。

## 3. 建议的系统用户与目录

不要让博客长期以 root 运行。以下示例使用专用用户 `blog`：

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin blog
sudo install -d -o blog -g blog /srv/linjinmu-blog
sudo install -d -m 700 -o blog -g blog /home/blog/.ssh
```

如果实际使用其他用户，后续路径、文件所有者和 systemd 的 `User` 必须保持一致。

## 4. 拉取公开框架

先将待上线改动合并到公开仓库的默认分支，再在 VPS 执行：

```bash
sudo -u blog git clone https://github.com/OWNER/FRAMEWORK_REPOSITORY.git /srv/linjinmu-blog
cd /srv/linjinmu-blog
sudo -u blog npm ci
```

绝不能把本地的 `node_modules/`、`dist/` 或 `.env` 直接复制到 VPS。

## 5. 安装私有文章仓库 Deploy Key

将已经在私有文章仓库中登记、并勾选写权限的私钥安全传输到：

```text
/home/blog/.ssh/linjinmu_blog_github
```

设置权限：

```bash
sudo chown blog:blog /home/blog/.ssh/linjinmu_blog_github
sudo chmod 600 /home/blog/.ssh/linjinmu_blog_github
```

如果使用 GitHub SSH 443 端口，首次由 `blog` 用户确认 GitHub 主机指纹：

```bash
sudo -u blog ssh -T -p 443 \
  -i /home/blog/.ssh/linjinmu_blog_github \
  -o IdentitiesOnly=yes \
  git@ssh.github.com
```

出现“successfully authenticated”且提示不提供 shell access 属于正常结果。不要把私钥内容写入 `.env`。

## 6. 创建生产 `.env`

```bash
cd /srv/linjinmu-blog
sudo -u blog cp .env.example .env
sudo chmod 600 .env
```

只在 VPS 本地编辑 `.env`。完整变量结构如下：

```dotenv
# Admin
ADMIN_USERNAME=
ADMIN_PASSWORD_HASH=
SESSION_SECRET=
ADMIN_HOST=127.0.0.1
ADMIN_PORT=4322
ADMIN_AUTH_DISABLED=false
BLOG_AUTO_BUILD=true

# R2 S3 API：供 Admin 上传图片
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_PUBLIC_BASE_URL=https://IMAGE_DOMAIN

# Wrangler 只在需要从 VPS 管理 Worker 时填写；通常可留空
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=

# GitHub 私有文章仓库
CONTENT_GIT_ENABLED=true
CONTENT_GIT_REPOSITORY=ssh://git@ssh.github.com:443/OWNER/PRIVATE_CONTENT_REPOSITORY.git
CONTENT_GIT_BRANCH=main
CONTENT_GIT_SSH_KEY_PATH=/home/blog/.ssh/linjinmu_blog_github
CONTENT_GIT_AUTHOR_NAME=
CONTENT_GIT_AUTHOR_EMAIL=
CONTENT_GIT_WORKTREE=server/data/content-repository

# SQLite 备份
BLOG_BACKUP_DIR=server/backups
BLOG_BACKUP_RETENTION_DAYS=14
```

要求：

- `ADMIN_PASSWORD_HASH` 使用 `npm run hash-password` 生成，不能填写明文密码。
- `SESSION_SECRET` 至少使用 32 字节安全随机数。
- `ADMIN_AUTH_DISABLED` 在生产环境必须为 `false`。
- `ADMIN_HOST` 必须保持为 `127.0.0.1`。
- `R2_PUBLIC_BASE_URL` 指向 Worker 的最终图片域名，不是 R2 公共开发 URL。
- `.env` 权限必须为 `600`，所有者必须是运行 Admin 的用户。

## 7. 恢复私有文章并首次构建

```bash
cd /srv/linjinmu-blog
sudo -u blog npm run content:git -- test
sudo -u blog npm run content:git -- pull
sudo -u blog npm test
sudo -u blog npm run build
```

检查：

- `content:git -- test` 成功连接私有仓库。
- `src/content/posts/` 已恢复 Markdown。
- `npm test` 全部通过。
- `dist/` 生成成功。

`content:git -- pull` 会用私有仓库快照替换本地文章目录；如果 VPS 已有尚未同步的文章，必须先备份或推送，不能直接执行恢复。

## 8. systemd 常驻 Admin

创建 `/etc/systemd/system/linjinmu-blog-admin.service`：

```ini
[Unit]
Description=LinJinmu Blog Admin API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=blog
Group=blog
WorkingDirectory=/srv/linjinmu-blog
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run admin
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

如果 `command -v npm` 不是 `/usr/bin/npm`，必须把 `ExecStart` 改成实际绝对路径。

启用服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now linjinmu-blog-admin
sudo systemctl status linjinmu-blog-admin
sudo journalctl -u linjinmu-blog-admin -n 100 --no-pager
```

Admin 发布文章时需要写入 `src/content/posts/`、`dist/`、`.admin-tmp/`、`server/data/` 和私有仓库工作目录，因此整个项目应归 `blog` 用户所有：

```bash
sudo chown -R blog:blog /srv/linjinmu-blog
```

## 9. Nginx 静态站点与 Admin 反代

示例站点配置：

```nginx
server {
    listen 80;
    server_name BLOG_DOMAIN;

    root /srv/linjinmu-blog/dist;
    index index.html;
    client_max_body_size 70m;

    location /admin-api/ {
        proxy_pass http://127.0.0.1:4322;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location /_astro/ {
        try_files $uri =404;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files $uri $uri/ $uri/index.html =404;
    }
}
```

检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

随后配置可信 HTTPS 证书，并确认 Nginx 的 HTTPS server 块仍传递：

```nginx
proxy_set_header X-Forwarded-Proto $scheme;
```

VPS 防火墙只公开必要端口，例如 SSH、80 和 443。绝不能公开 4322。

## 10. Cloudflare 配置

1. 将博客域名代理到 VPS 的 Nginx，仅开放 80/443。
2. 将 Worker 的允许来源更新为最终博客域名。
3. 确认图片域名经过 Worker，并能读取私有 R2 对象。
4. 在公开网站前配置 Cloudflare Access。

Access 必须同时保护：

```text
/admin
/admin/*
/admin-api/*
```

只保护 `/admin` 页面而遗漏 `/admin-api/*` 是无效保护。Access 策略建议只允许管理员邮箱。博客自己的密码认证仍保持开启，形成双层保护。

## 11. 上线验收

上线前逐项检查：

```bash
cd /srv/linjinmu-blog
sudo -u blog npm test
sudo -u blog npm run build
sudo -u blog npm run content:git -- test
sudo systemctl is-active linjinmu-blog-admin
sudo nginx -t
curl -I https://BLOG_DOMAIN/
```

然后通过浏览器验证：

1. 首页、文章、归档、摄影页和暗色模式正常。
2. 手机端字体、滚动和文章返回动画正常。
3. Access 能拦截未授权用户。
4. Admin 能登录和退出。
5. 发布一篇临时测试文章，页面能够访问。
6. Admin 显示文章已同步到 GitHub 私有仓库。
7. 修改并删除测试文章，私有仓库产生对应提交。
8. 上传一张测试图，浏览器经 Worker 返回 `200` 和正确 `Content-Type`。
9. `server/data/blog.db` 正常记录图库元数据。

测试完成后删除临时文章和图片引用；是否删除 R2 测试对象由管理员决定。

## 12. 定时备份

文章由 GitHub 私有仓库保存，图片由 R2 保存，只需备份 SQLite 图库元数据：

```bash
sudo -u blog sh -lc 'cd /srv/linjinmu-blog && npm run backup'
```

cron 示例见 `BACKUP.md`。备份目录不能进入公开 Git 仓库，必要时应复制到独立备份位置。

## 13. 日常更新

框架更新：

```bash
cd /srv/linjinmu-blog
sudo -u blog git pull --ff-only
sudo -u blog npm ci
sudo -u blog npm test
sudo -u blog npm run build
sudo systemctl restart linjinmu-blog-admin
```

私有文章通常由 Admin 自动同步。需要手动检查时：

```bash
sudo -u blog npm run content:git -- test
sudo -u blog npm run content:git -- push
```

只有 Worker 代码或绑定发生变化时才运行：

```bash
npm ci --prefix linjinmu-image-worker
npm run worker:deploy
```

公开框架中的 Worker 配置使用安全占位符。部署前必须在本地私有副本中完成以下替换，并再次检查不要把账户令牌提交到 Git：

- 将 `linjinmu-image-worker/wrangler.jsonc` 中的 `YOUR_R2_BUCKET_NAME` 替换为实际 bucket。
- 将 `YOUR_KV_NAMESPACE_ID` 替换为实际 KV 命名空间 ID。
- 将 `linjinmu-image-worker/src/worker.js` 中的 `example.com` 替换为最终博客域名。

如果 Cloudflare 上的 Worker 已经正常运行，不要仅为迁移 VPS 重复部署。

## 14. 回滚

框架回滚前先记录当前提交并备份数据库：

```bash
cd /srv/linjinmu-blog
sudo -u blog git rev-parse HEAD
sudo -u blog npm run backup
```

切换到已知可用的框架提交并重建：

```bash
sudo systemctl stop linjinmu-blog-admin
sudo -u blog git switch --detach KNOWN_GOOD_COMMIT
sudo -u blog npm ci
sudo -u blog npm test
sudo -u blog npm run build
sudo systemctl start linjinmu-blog-admin
```

回到默认分支：

```bash
sudo systemctl stop linjinmu-blog-admin
sudo -u blog git switch main
sudo -u blog git pull --ff-only
sudo -u blog npm ci
sudo -u blog npm run build
sudo systemctl start linjinmu-blog-admin
```

恢复文章前先复制当前 `src/content/posts/`，再执行 `npm run content:git -- pull`。恢复 SQLite 时先停止 Admin，再用备份文件替换 `server/data/blog.db`，确认所有者为 `blog` 后启动服务。

## 15. 安全检查

提交或部署前确认公开仓库没有跟踪私密文件：

```bash
git ls-files -- .env '.env.*' 'src/content/posts/*' 'server/data/*' 'server/backups/*'
git status --short
```

预期只可能看到安全的 `.env.example` 和专门保留空目录的 `.gitkeep`，不能出现真实文章、数据库、密钥或生产 `.env`。

生产要求：

- `.env` 和 SSH 私钥权限为 `600`。
- Admin 密码、Session Secret、R2 密钥使用独立随机值。
- 4322 不对公网开放。
- Cloudflare Access 和博客密码认证同时启用。
- 不在命令输出、日志、截图或 AI 对话中暴露秘密值。

## 16. 给迁移 AI 的启动提示词

```text
你正在把这个博客迁移到 Linux VPS。
先完整阅读仓库根目录的 AGENTS.md、DEPLOY_VPS.md、ADMIN.md 和 BACKUP.md。
在执行任何写操作前，先只读检查 VPS 系统、Node/Git/Nginx 版本、目录、端口、DNS 和现有服务。
不得输出、提交或复制展示任何密码、令牌、R2 凭据、Session Secret 或 SSH 私钥内容。
公开框架仓库、私有文章仓库、R2 图片和 blog.db 必须保持分离。
每完成一个阶段都运行对应验证；发生错误时保留当前可用的 dist 和数据，不得使用 git reset --hard。
按照 DEPLOY_VPS.md 的顺序执行，并在最终报告中列出已完成项、验证结果和仍需我手动完成的 Cloudflare 操作。
```
