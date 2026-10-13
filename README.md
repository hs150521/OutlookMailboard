# OutlookMailboard

一套供单个管理员使用的轻量多邮箱管理后台。集中查看 Outlook 邮箱最近收到邮件的时间，并按平台记录每个邮箱是否注册过。浏览器只负责操作；邮箱授权、平台状态及已读取邮件保存在服务器端。

本项目是独立实现，功能思路参考了 [MS_OAuth2API_Next](https://github.com/HChaoHui/MS_OAuth2API_Next)（作者在上游项目标注为 Unix）。没有复制其前端、后端源码或 [Docker PR #1](https://github.com/HChaoHui/MS_OAuth2API_Next/pull/1) 的代码；项目源码按本仓库的 [MIT 许可证](LICENSE) 发布。依赖包各自保留其许可证。Outlook 是 Microsoft 的商标，本项目与 Microsoft 没有关联。

## 功能

- 第一次访问创建唯一管理员的用户名和密码，以后登录使用；没有公开注册入口。
- 批量导入邮箱，兼容 `邮箱----client_id----refresh_token` 和上游四段格式（密码段会被忽略）。授权令牌在服务端用 AES-256-GCM 加密。
- 支持导出选中或全部邮箱，以及批量删除；导出的明文令牌文件需自行妥善保管。
- “全部平台”只显示邮箱、最后收信时间、距今天数、最后检查时间，支持按收信时间排序与邮箱搜索。
- “指定平台”可添加平台，并逐个切换邮箱的已注册／未注册状态。新平台及新邮箱默认为未注册，各平台相互独立。
- 手动检查收件箱与垃圾邮件；邮箱详情显示最近 30 封邮件的发件人、主题、正文。没有定时邮件轮询。
- 可在邮箱详情确认后清空当前收件箱或垃圾邮件文件夹；这会删除微软邮箱中的邮件。
- 优先尝试 Microsoft Graph `Mail.Read`；现有令牌没有 Graph 邮件权限时尝试 Outlook IMAP OAuth。

## Docker 部署

要求 Docker Compose。克隆仓库后运行：

```sh
docker compose up -d --build
```

默认仅在服务器的 `127.0.0.1:3000` 监听端口映射。可运行 `ssh -L 3000:127.0.0.1:3000 user@your-server` 后访问本机 `http://127.0.0.1:3000`，或在可信反向代理后配置 HTTPS。使用反向代理时将 `TRUST_PROXY=1` 写进服务器的 `.env`，再运行 Compose。首次打开网页会要求设置管理员账号。服务器 SSH 登录和网页管理员登录是两个独立入口。

`mailboard_data` 卷必须随项目备份：其中有 SQLite 数据库和自动生成的加密密钥。丢失密钥会导致已保存的刷新令牌无法解密。不要把 `data/`、`.env`、数据库或令牌提交到公开仓库。

## 本地运行

要求 Node.js 20.19 及以上：

```sh
npm ci
HOST=127.0.0.1 npm start
```

默认数据目录为 `./data`，端口 3000。运行 `npm test` 执行自动化测试。

## 邮箱授权

添加邮箱时填写邮箱地址、Microsoft OAuth 应用的 `client_id` 和该邮箱的 `refresh_token`。本项目不提供取得 refresh token 的向导；可使用你现有的授权流程。Graph 读取需要 `Mail.Read` 和 `offline_access`，清空文件夹需要 `Mail.ReadWrite`；IMAP 读取和清空需要 `IMAP.AccessAsUser.All` 和 `offline_access`。应用使用 Microsoft 个人账号的 `consumers` 授权端点。

导入后点“刷新”才会访问微软邮件服务。最后收信时间来自最近拉取的收件箱与垃圾邮件，不等同于最后检查时间；从未检查的邮箱显示为“未检查”。邮件正文以纯文本展示，不执行邮件里的 HTML 或脚本。

## 数据与安全

管理员密码使用 `scrypt` 哈希，浏览器会话使用 HttpOnly、SameSite=Strict Cookie 和 CSRF 校验。首次设置没有默认密码。刷新令牌在数据库中加密保存；如不提供 `MAILBOARD_ENCRYPTION_KEY`，应用会在数据目录生成持久密钥。正式对公网开放时请使用 HTTPS，并由可信反向代理转发。仅在这种部署下设置 `TRUST_PROXY=1`。

本项目面向个人约 30 个邮箱，不提供多用户权限、自动收件任务或向外开放的邮件 API。
