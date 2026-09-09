# LinJinmu Blog

林衿慕的个人博客。基于 Astro 构建，包含文章、归档、摄影时间轴和轻量 Admin 后台。

## 功能

- 首页最近文章与按需加载、缓存正文的桌面端文章预览
- 日常、笔记分类和完整归档
- Markdown 文章
- 明暗主题与夜间流星背景
- R2 图片图库，区分文章图片和摄影作品
- 摄影时间轴与当前页面照片预览
- 文章和摄影作品的 Admin 管理界面
- 发布或修改文章后自动重新构建静态页面

## 本地运行

要求 Node.js 22.16.0 或更高版本。

```powershell
npm install
$env:ASTRO_TELEMETRY_DISABLED='1'
npm run dev
```

打开：

- 博客：`http://localhost:4321`
- Admin：`http://localhost:4321/admin`

`npm run dev` 会同时启动 Astro 和本地 Admin API。只启动博客前端可以使用 `npm run dev:web`。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 同时启动博客和 Admin API |
| `npm run dev:web` | 只启动 Astro 开发服务器 |
| `npm run build` | 构建静态博客到 `dist/` |
| `npm run build:publish` | 构建验证成功后切换产物，失败时恢复旧版本 |
| `npm test` | 运行后台接口、发布恢复、图片、图库与文章同步测试 |
| `npm run test:browser` | 验证后台 HTML 转义和首页按需预览 |
| `npm run preview` | 预览构建结果 |
| `npm run admin` | 只启动 Admin API |
| `npm run hash-password` | 生成 Admin 密码哈希 |

首次运行浏览器测试前执行 `npx playwright install chromium`。如果 Windows 已安装 Edge，
可在 PowerShell 中设置 `$env:PLAYWRIGHT_CHANNEL='msedge'` 后运行 `npm run test:browser`。
浏览器测试使用合成文章与拦截的 API，不会访问真实文章、R2 或生产后台。

## 项目结构

```text
src/
  components/admin/  Admin 共用界面
  content/posts/     Markdown 文章
  data/              文章和摄影数据入口
  layouts/           全站布局
  pages/             页面结构与路由
  scripts/           页面交互和 Admin 客户端逻辑
  styles/            页面样式
server/
  admin-server.mjs   环境加载与 Admin API 启动
  admin-app.mjs      Admin 路由、文章管理和 R2 上传
  publisher.mjs      暂存构建、产物切换和失败恢复
  data/              图片图库索引
  trash/posts/       被删除文章的暂存位置
scripts/             本地启动与密码工具
public/              静态资源
```

## 内容与图片

文章保存在 `src/content/posts/`，每篇文章是一个 Markdown 文件。Admin 上传的文章图片保存在 R2 的 `blog/` 路径，摄影作品保存在 `photos/` 路径。

R2 存储桶可以保持私有；博客展示图片时通过 Cloudflare Worker 域名访问，Admin 上传则使用仅限该存储桶的 S3 API 凭据。

## Admin 配置

本地密钥和登录配置放在 `.env`，该文件已被 Git 忽略，不要提交到仓库。完整的环境变量、密码配置和 Nginx 反向代理示例见 [ADMIN.md](./ADMIN.md)。

正式部署前应启用 Admin 登录，并妥善备份 `src/content/posts/` 与 `server/data/blog.db`。

## 构建与部署

```powershell
npm run build
```

本地静态站点输出到 `dist/`；Docker 生产环境通过 `BLOG_DIST_DIR` 输出到 `runtime/dist/`。生产部署见 [DEPLOY_VPS.md](./DEPLOY_VPS.md)。在 VPS 上需要分别提供：

1. `dist/` 中的静态博客；
2. `server/admin-server.mjs` 提供的 Admin API；
3. 将 `/admin-api/` 反向代理到 Admin API。

修改文章或摄影图库后，重新构建即可让静态页面读取最新内容。
