# 落地页统计后台

后台地址：https://wechat-landing-stats.schmidtdean438.workers.dev/

复用现有 Cloudflare Worker 和 D1。登录密码保存在 Worker 的 `ADMIN_PASSWORD` secret 中，不应写进源码。页面继续部署到 GitHub Pages。

## 统计内容与口径

- 默认只看 `/zss.github.io/`，可切换历史未知页面或全部页面；日期按 UTC+8，支持今天、近 7 天和近 30 天。
- UV 是浏览器随机访客编号的去重数，不等于真实人数；PV 是浏览事件数；访问次数是有浏览事件的会话数，每次页面加载生成新会话编号。
- 周期复制率是同页面、所选日期内既有浏览又有复制的会话数 / 浏览会话数。每日复制列只算同一天浏览并复制，不能与跨日周期口径直接相加。
- 时间线记录页面浏览、弹窗展示/关闭、复制成功/失败、实际看到步骤、滚动里程碑、可见停留更新和离开。停留是累计可见时长快照，聚合取最大值，不能把心跳相加。
- 来源可用 `?utm_source=facebook&utm_campaign=campaign-name` 标记；引荐只保存域名，环境/系统由 User-Agent 分类，地区为 Cloudflare 国家/地区代码。
- 历史事件未采集页面路径和会话编号，保留为历史未知数据，无法补还原行为轨迹。网页不能判断复制后是否实际添加微信好友。
- 不记录 IP、输入内容或录屏。匿名编号会保存在浏览器本地；清理存储或更换浏览器会被视为新访客。浏览器拦截、断网、关闭页面等可能造成漏报。

后台显示最近 100 次访问、每次最多 500 条事件；筛选范围最多 30 天。数据接口需要登录且不缓存。

## 开发与测试

需要 Node.js 24（测试使用内置 SQLite）。在本目录运行：

```sh
npm ci
npm test
npm run dev
```

本地 `.dev.vars` 中设置独立测试密码 `ADMIN_PASSWORD`。Wrangler 默认使用本地数据库。现有 `schema.sql` 是旧表基线；空白本地库先执行基线，再迁移：

```sh
npx wrangler d1 execute wechat-landing-stats --local --file schema.sql
npx wrangler d1 migrations apply wechat-landing-stats --local
```

在仓库根目录运行前端回归：

```sh
node --test tests/tracker.test.cjs
```

## 发布

先备份 D1；线上已有旧表时只应用增量迁移，再部署后台，最后发布落地页。迁移不会删除历史事件，重复迁移由 Wrangler 的迁移表防止。不要把本地配置、备份、密码或登录 cookie 提交到仓库。

```sh
npx wrangler d1 migrations apply wechat-landing-stats --remote
npx wrangler deploy --dry-run
npm run deploy -- --keep-vars
```

已有密码部署时保留；重设密码使用 Wrangler secret 管理，旧登录 cookie 会随密码变化失效。
