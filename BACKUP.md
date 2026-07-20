# SQLite 图库备份

图库元数据保存在 `server/data/blog.db`。首次启动 Admin 时，如果检测到旧的
`server/data/media-library.json`，会自动迁移到 SQLite；旧 JSON 不会自动删除。

执行一次备份：

```bash
npm run backup
```

每次只会生成一个 SQLite 文件：

```text
server/backups/blog-2026-07-20T03-00-00-000Z.db
```

不会备份 Markdown 文章、R2 图片、`.env`、源代码或构建产物。文章由 GitHub
私有仓库保存，图片继续保存在 R2。

默认保留 14 天，可以在 `.env` 中调整：

```bash
BLOG_BACKUP_DIR=/path/to/backup
BLOG_BACKUP_RETENTION_DAYS=14
```

VPS 上可以通过 `crontab -e` 每天执行一次：

```cron
20 3 * * * cd /path/to/your/blog && /usr/bin/npm run backup >> /var/log/linjinmu-blog-backup.log 2>&1
```
