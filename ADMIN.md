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

当前开发版默认禁用密码登录。如果以后想恢复密码登录，设置：

```bash
ADMIN_AUTH_DISABLED=false
```

无密码模式会直接允许访问发布接口，只建议在本地、内网、或 Nginx 已经额外做了访问限制的情况下使用。

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
server/data/media-library.json
```

后台会显示这个图库。点击图库里的图片，会把对应 Markdown 图片语法插入到正文光标位置。

上传图片时会计算 SHA-256。如果同一张图已经上传过，会直接复用图库里的旧 URL，不会重复上传到 R2。

## 4. 启动 Admin API

```bash
npm run admin
```

建议用 `systemd` 或 `pm2` 在 VPS 上常驻运行。

本地开发时需要开两个终端：

```powershell
# 终端 1：博客页面
$env:ASTRO_TELEMETRY_DISABLED='1'
npm run dev

# 终端 2：Admin API，当前默认无密码模式
npm run admin
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

1. 写入 `src/content/posts/{slug}.md`
2. 自动执行 `npm run build`
3. 让 `dist` 里的静态页面更新

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
