# Admin 后台说明

这个后台用于个人发布博客：

- `/admin`：写作界面
- `/admin-api/login`：登录
- `/admin-api/posts`：发布 Markdown 文章
- `/admin-api/posts/:slug`：读取、修改、删除单篇文章
- `/admin-api/upload`：上传图片到 Cloudflare R2
- `/admin-api/media`：读取图库

## 1. 生成密码哈希

不要把明文密码写到 VPS。先在本地运行：

```bash
npm run hash-password
```

输入你的管理员密码后，会得到：

```bash
ADMIN_PASSWORD_HASH=scrypt$...
```

把这串哈希放到 VPS 环境变量里。

## 2. 必需环境变量

```bash
ADMIN_USERNAME=LinJinmu
ADMIN_PASSWORD_HASH=scrypt$...
SESSION_SECRET=一串很长的随机字符
ADMIN_PORT=4322
BLOG_ROOT=/path/to/your/blog
```

`SESSION_SECRET` 可以用下面命令生成：

```bash
openssl rand -base64 48
```

默认启用密码登录。必须配置用户名、密码哈希和 Session Secret；生产 Compose 强制保持：

```bash
ADMIN_AUTH_DISABLED=false
```

仅在本地开发时，可以显式设置 `ADMIN_AUTH_DISABLED=true`。该模式直接允许访问发布接口，不能用于公网。

## 3. R2 图片上传环境变量

如果要使用图片上传，需要配置：

```bash
R2_ACCOUNT_ID=你的 Cloudflare Account ID
R2_ACCESS_KEY_ID=你的 R2 Access Key ID
R2_SECRET_ACCESS_KEY=你的 R2 Secret Access Key
R2_BUCKET=你的 bucket 名称
R2_PUBLIC_BASE_URL=https://你的图片域名
```

后台上传图片后，会返回公开 URL，并自动插入 Markdown：

```md
![图片名](https://你的图片域名/2026/07/example.webp)
```

上传成功的图片会记录到本地图库索引：

```text
server/data/blog.db
```

后台会显示这个图库。点击图库里的图片，会把对应 Markdown 图片语法插入到正文光标位置。

上传图片时会计算 SHA-256。如果同一张图已经上传过，会直接复用图库里的旧 URL，不会重复上传到 R2。

图片会在服务端重新解码和优化后再上传：

- 只接受 JPEG、PNG、WebP 和 AVIF，最大 45 MB
- 自动按 EXIF 方向旋转，但不会保留 EXIF、GPS 等元数据
- 博客正文图最长边限制为 2400px，并转换为 WebP
- 摄影作品最长边限制为 3200px；横图生成 960×720、竖图生成 720×960、方图生成 960×960 的居中裁剪缩略图，小图不放大
- 原始文件不会上传到 R2

旧图库中的图片不会自动改写；在 Admin 中重新上传同一原文件时，会用新管线替换对应图库记录。

## 4. 启动 Admin API

```bash
npm run admin
```

VPS 使用 Docker Compose 常驻运行，步骤见 `DEPLOY_VPS.md`。

本地开发只需一个终端，`npm run dev` 会同时启动 Astro 和 Admin API：

```powershell
$env:ASTRO_TELEMETRY_DISABLED='1'
npm run dev
```

Astro dev 已经配置了 `/admin-api` 代理，会把请求转到 `http://127.0.0.1:4322`。

## 5. Nginx 反代示例

Astro 构建后的静态文件仍然由 Nginx 托管，Admin API 单独反代：

```nginx
location / {
    root /path/to/your/blog/dist;
    try_files $uri $uri/ /index.html;
}

location /admin-api/ {
    proxy_pass http://127.0.0.1:4322/admin-api/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## 6. 发布文章

登录 `/admin` 后填写：

- 标题
- Slug，可留空自动生成
- 分类：日常 / 笔记
- 日期
- 阅读时间
- 描述
- 正文 Markdown

点击发布后，后端会：

1. 串行执行文章和图库变更，避免并发构建互相覆盖
2. 原子写入 `src/content/posts/{slug}.md`
3. 把网站构建到输出目录同级的 `.admin-tmp/` 临时目录，验证首页产物存在
4. 构建成功后整体替换 `dist`
5. 构建失败时恢复文章和图库数据，继续保留原来的 `dist`；如果自动恢复也失败，保留旧产物并返回恢复目录，禁止自动删除该目录

Docker 中输出目录为 `/app/runtime/dist`，暂存目录为 `/app/runtime/.admin-tmp`。文章事务使用 `src/content/.admin-tmp`，失败事务保留用于恢复，确认内容完整后再手动清理。

如果暂时不想每次发布后自动构建，可以设置：

```bash
BLOG_AUTO_BUILD=false
```

## 7. 管理文章

Admin 首页会显示“文章管理”：

- 点击“编辑”会把文章载入编辑器
- 点击“保存修改”会覆盖对应 Markdown 文件
- 修改 slug 时，会写入新文件，并把旧文件移动到回收目录
- 点击“删除文章”不会立刻永久删除，而是移动到：

```text
server/trash/posts/
```

每次修改或删除后，默认会重新执行 `npm run build`。

## 8. GitHub 私有文章仓库

文章可以在发布、修改和删除后自动提交到独立的 GitHub 私有仓库。私钥必须保存在 `.ssh`，`.env` 只填写路径：

```bash
CONTENT_GIT_ENABLED=true
CONTENT_GIT_REPOSITORY=git@github.com:OWNER/Blog_text.git
CONTENT_GIT_BRANCH=main
CONTENT_GIT_SSH_KEY_PATH=/home/blog/.ssh/linjinmu_blog_github
CONTENT_GIT_AUTHOR_NAME=LinJinmu
CONTENT_GIT_AUTHOR_EMAIL=你的GitHub邮箱
CONTENT_GIT_WORKTREE=server/data/content-repository
```

自动同步失败不会撤销已经成功发布到 VPS 的文章，Admin 会显示警告；下一次文章操作会再次同步完整快照。也可以手动执行：

```bash
npm run content:git -- test
npm run content:git -- push
```

在新 VPS 上恢复私有仓库中的文章：

```bash
npm run content:git -- pull
npm run build
```

私有仓库只保存 `posts/` 下的 Markdown，不包含 `.env`、数据库、图片或网站框架。
