# YanMo的个人博客

一个基于 HTML、CSS、JavaScript 与 Node.js（Express + SQLite）的个人博客项目，聚焦信息安全学习记录与内容展示。

## 主要特点

### 视觉与交互
- 赛博风格主题，包含霓虹色、高对比和动效元素。
- 桌面与移动端响应式布局，兼顾大屏阅读与小屏触控。
- 统一导航交互、滚动动画与状态提示，页面体验一致。
- 关键操作具备反馈（成功/失败提示、按钮状态变化、加载过程可见）。

### 内容与页面
- 前台完整内容链路：
	- 首页：只展示本站入口（Gateway Hero + 终端）、开源项目与安全情报看板，不承载文章正文。
	- 文章列表：按列表浏览文章，支持跳转详情。
	- 文章详情：阅读正文，异常参数时有回退机制保障可访问性。
	- 关于/联系：展示作者信息与联系表单。
	- 留言板：访客留言互动。
	- 友链页：展示通过审核的友链信息与头像。
- 后台管理能力：
	- 文章管理：新增、编辑、删除与发布内容维护。
	- 留言管理：查看与处理用户留言。
	- 友链审核：审核申请、控制展示状态。
	- 账户设置：支持管理员账号与密码修改。

### 数据与接口
- Node.js + Express 后端（`server/server.js`）提供静态资源与全部 API，包括审计日志查询与 CSV 导出。
- Vercel 环境由 `api/[...route].js` 提供同等 API，可选 PostgreSQL。
- SQLite 持久化（`data/blog.db`），用于文章、留言、友链等数据存储。
- 本地模拟 API（`src/js/local-api.js`）支持 `local/server` 模式切换：
	- `local`：前端本地模拟，适合离线开发与静态调试。
	- `server`：请求真实后端，适合联调与真实数据验证。

### 最近更新（关键）
- 目录规范化：页面、样式、脚本、资源、配置分别归入 `src/`、`assets/`、`config/`，根目录只保留包管理、部署与仓库元文件。
- 旧地址兼容：`/index.html`、`/admin.html`、`/admin-dashboard.html`、`/link-apply.html`、`/pages/*` 自动跳转或重写到 `/src/pages/` 下的规范页面，根目录不再放 HTML。
- 本地后端统一为 Node.js（Express + SQLite），启动与测试只需要 Node.js 环境。
- 测试统一由 `config/vitest.config.js` 启动，临时 SQLite 库与凭据文件用后自动清理。
- 管理员支持修改账号和密码；本机应急重置需已登录并输入确认口令 `RESET_ADMIN`。
- 友链头像上传优化：
	- 统一 1MB 限制（前后端规则一致）。
	- 上传前自动压缩与自动裁剪，降低大图失败率。
	- 支持手动裁剪取景（可调缩放与位置）。
	- 统一导出 WebP，兼顾体积与清晰度。
- 友链与后台头像样式统一为圆形展示。

### 安全与稳定性
- 管理员凭据采用文件持久化，兼容历史密码文件读取；密码使用 PBKDF2-SHA256 加盐哈希（默认 600,000 次迭代，登录成功时自动升级旧哈希）。
- 管理员登录启用 IP 限流与锁定（默认 10 分钟窗口 5 次失败后锁定 15 分钟），并记录成功/失败/拦截审计日志。
- 登录校验使用常量时间比较，且用户名错误时仍执行密码哈希，降低账号枚举与时序侧信道风险。
- 会话 Cookie 使用 `HttpOnly` + `SameSite=Lax`，生产环境或显式配置时启用 `Secure`；会话同时受绝对有效期与空闲超时约束。
- 修改管理员密码后，其他设备上的旧会话立即失效；云端签名 Cookie 绑定当前凭据指纹，改密后旧 Token 自动失效。
- 新密码要求至少 10 位，并包含大写字母、小写字母、数字、符号中的至少三类。
- 默认不信任 `X-Forwarded-For`；仅在反向代理后部署时通过 `TRUST_PROXY=1` 显式开启，避免伪造 IP 绕过限流。
- 认证接口返回 `Cache-Control: no-store`，并附加 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy` 等安全响应头。
- 本地静态服务只暴露 `src/` 与 `assets/`；Vercel 路由同时拦截 `server/`、`data/`、`lib/`、`config/`、`tests/`、`docs/` 及包元文件，避免后端源码与凭据文件被直接下载。
- 提供管理员应急重置（已登录 + 本机 + 确认口令）与凭据文件回退机制，降低维护阻塞。
- 上传链路包含大小校验、格式处理与失败提示，避免脏数据入库。
- 本地模拟与真实后端接口行为尽量一致，减少“开发可用、上线异常”的偏差。

## 技术栈

- 前端：HTML5、CSS3、原生 JavaScript（无框架、无构建步骤）
- 后端：Node.js 20+ + Express（`server/server.js`），SQLite 持久化
- 云端：Vercel Serverless（`api/[...route].js`），可选 PostgreSQL
- 测试：Vitest + Node 内置 `fetch` / `supertest`

## 快速启动

环境要求：Node.js 20+。

```bash
npm install                  # 根依赖：nodemailer、pg、测试工具
npm --prefix server install  # 后端依赖：Express、SQLite3 等
npm start                    # 启动 Express，监听 :3000
npm run dev                  # 开发模式（nodemon 热重载）
```

- 后端入口：`server/server.js`（Express + SQLite），同时提供静态资源与 API。
- 自动读取根目录 `.env`（可用 `ENV_FILE` 指定其它路径）。
- 端口由 `PORT` 控制，默认 `3000`；数据库默认写入 `data/blog.db`（可用 `DB_PATH` 修改）。

启动后访问：

| 用途 | 地址 |
| --- | --- |
| 站点入口 | <http://localhost:3000/>（加载页自动进入首页） |
| 首页 | <http://localhost:3000/src/pages/index.html> |
| 文章列表 | <http://localhost:3000/src/pages/articles.html> |
| 管理登录 | <http://localhost:3000/src/pages/admin.html> |

> 端口被占用时：`PORT=3001 npm start`（PowerShell：`$env:PORT=3001; npm start`）。

## 常用地址

| 用途 | 规范地址 | 兼容地址 |
| --- | --- | --- |
| 站点入口 | `/` → `/src/pages/loading.html` | `/index.html` |
| 首页 | `/src/pages/index.html` | — |
| 文章列表 | `/src/pages/articles.html` | `/pages/articles.html` |
| 文章详情 | `/post/<id>` | `/src/pages/post.html?id=<id>` |
| 友链申请 | `/src/pages/link-apply.html` | `/link-apply.html` |
| 管理登录 | `/src/pages/admin.html` | `/admin.html` |
| 管理后台 | `/src/pages/admin-dashboard.html` | `/admin-dashboard.html` |
| 云端 API | `/api/*` | — |

> 跳转由 `vercel.json` 与 `server/server.js` 共同实现，根目录不再保留 HTML 壳文件。
>
> 如果使用第三方静态预览（如 VS Code Live Server），`/` 不会自动映射，请直接访问 `/src/pages/loading.html` 或 `/src/pages/index.html`。

## 测试

```bash
npm test           # 单次运行全部用例
npm run test:watch # 监听模式
npm run test:ui    # 打开 Vitest UI（需先 npm i -D @vitest/ui）
```

- 配置：`config/vitest.config.js`（`root` 指回仓库根，`include` 匹配 `tests/**/*.test.js`）。
- 覆盖：Node 后端接口与鉴权、审计日志（分页/筛选/CSV 导出）、Vercel API 路由（登录/限流/CSRF/输入校验/审计）、友链可用性检查（含 SSRF 防护）、SMTP 邮件。
- 当前为 4 个测试文件、83 个用例；测试使用临时数据库与临时凭据文件，结束后自动清理，不会污染 `data/`。

## 管理员账号

- 默认账号：`admin`
- 默认密码：`admin`
- 首次登录后请尽快在后台修改账号与密码；新密码至少 10 位且包含三类字符。
- 凭据文件：
	- `data/admin-credentials.json`
	- `data/admin-password.txt`（兼容）

> - 忘记密码：停止服务，删除 `data/admin-credentials.json` **和** `data/admin-password.txt`（后者可能残留 `managed_by_hash_credentials` 占位串），重启后恢复为 `admin/admin`。
> - 已登录时：可在后台“账户设置”使用本机应急重置（仅允许 `localhost`，需输入确认口令 `RESET_ADMIN`）。

## 项目结构

```text
BoKe-main/                                # 仓库根目录（同时是站点根目录）
├── src/                                  # 前端源码
│   ├── pages/                            # 业务页面（URL: /src/pages/*.html）
│   │   ├── loading.html                  # 站点入口加载页（/ 返回本页）
│   │   ├── index.html                    # 首页
│   │   ├── about.html                    # 关于页
│   │   ├── articles.html                 # 文章列表页
│   │   ├── post.html                     # 文章详情页（模板）
│   │   ├── contact.html                  # 联系页
│   │   ├── guestbook.html                # 留言板页面
│   │   ├── links.html                    # 友链展示页
│   │   ├── link-apply.html               # 友链申请页（含头像上传/裁剪）
│   │   ├── message-apply.html            # 留言申请页
│   │   ├── admin.html                    # 管理员登录页
│   │   └── admin-dashboard.html          # 管理后台页面
│   ├── css/                              # 样式（URL: /src/css/*.css）
│   │   ├── styles.css                    # 主样式：布局、组件、响应式等
│   │   ├── beautify.css                  # 视觉增强样式：特效与细节修饰
│   │   ├── music-box.css                 # 音乐盒样式
│   │   └── theme-lumina.css              # 主题皮肤
│   └── js/                               # 前端脚本（URL: /src/js/*.js）
│       ├── date-utils.js                 # 日期工具
│       ├── home-page.js                  # 首页逻辑
│       ├── local-api.js                  # 本地模拟 API（local/server 模式）
│       ├── music-box.js                  # 音乐盒
│       ├── palette-manager.js            # 配色管理
│       ├── theme-boot.js                 # 主题预加载（防闪烁）
│       ├── utils.js                      # 通用工具
│       └── ux-enhancements.js            # 交互增强
├── assets/                               # 静态资源（URL: /assets/*）
│   ├── images/                           # 头像、Logo 等图片
│   ├── audio/                            # 音乐盒音轨与 playlist.json
│   └── vendor/                           # 第三方库（版本号写入文件名）
├── api/                                  # Vercel Serverless 接口
│   ├── index.js                          # /api 入口
│   ├── [...route].js                     # 动态路由分发
│   ├── check-links.js                    # 友链可用性检查
│   └── package.json                      # 声明 CommonJS 模块类型
├── server/                               # 本地后端（Node.js + Express）
│   ├── server.js                         # HTTP 服务、静态资源与全部 API
│   ├── rss-poller.js                     # RSS 定时抓取
│   └── package.json                      # Node 依赖与脚本配置
├── lib/
│   └── mailer.cjs                        # 邮件发送（api 与测试共用）
├── data/                                 # 运行时持久化数据（不在前端引用）
│   ├── blog.db                           # SQLite 数据库（已忽略提交）
│   ├── cloud-data.json                   # 无数据库部署的兼容数据
│   ├── admin-credentials.json            # 管理员凭据（运行时生成）
│   ├── admin-password.txt                # 历史兼容密码（可选）
│   └── views.txt                         # 浏览量计数
├── config/
│   └── vitest.config.js                  # Vitest 配置（npm test 自动加载）
├── docs/
│   ├── DEPLOY.md                         # 部署与运维指南
│   └── STRUCTURE.md                      # 目录、命名与引用规范
├── tests/                                # Vitest 测试
├── vercel.json                           # Vercel 部署配置
├── package.json                          # 依赖与脚本
├── package-lock.json
├── .env.example
├── .gitignore
├── LICENSE
└── README.md
```

> 根目录只保留包管理、部署与仓库元文件；页面、样式、脚本、资源、配置、后端分别归入 `src/`、`assets/`、`config/`、`server/`、`api/`、`lib/`、`docs/`、`tests/`。
>
> 旧地址（`/index.html`、`/admin.html`、`/admin-dashboard.html`、`/link-apply.html`、`/pages/*`）会自动跳转或重写到 `/src/pages/` 下的规范页面，根目录不再放 HTML。

> 目录职责、命名规则与引用方式的完整约定见 [docs/STRUCTURE.md](docs/STRUCTURE.md)。

## 环境变量

本地把 `.env.example` 复制为 `.env`，`server/server.js` 会自动读取；线上在 Vercel → Settings → Environment Variables 配置。

| 变量 | 适用 | 说明 |
| --- | --- | --- |
| `PORT` | 本地 Node | 监听端口，默认 `3000` |
| `DB_PATH` | 本地 Node | SQLite 文件路径，默认 `data/blog.db` |
| `ENV_FILE` | 本地 Node | 指定 `.env` 路径，默认仓库根 `.env` |
| `ADMIN_CREDENTIALS_FILE` | 本地 Node | 管理员凭据文件，默认 `data/admin-credentials.json` |
| `ADMIN_PASSWORD_FILE` | 本地 Node | 历史密码文件，默认 `data/admin-password.txt` |
| `TRUST_PROXY` | 本地 Node | 仅部署在可信反向代理后时设为 `1`，才信任 `X-Forwarded-For` |
| `SESSION_COOKIE_SECURE` | 本地 Node | 通过 HTTPS 访问时设为 `1`，为管理员 Cookie 添加 `Secure` |
| `SESSION_TTL_MS` | 本地 / Vercel | 会话绝对有效期，默认 12h |
| `SESSION_IDLE_TTL_MS` | 本地 Node | 会话空闲超时，默认 2h |
| `PASSWORD_HASH_ITERATIONS` | 本地 / Vercel | PBKDF2-SHA256 迭代次数，默认 `600000`（最低 `100000`） |
| `LOGIN_WINDOW_MS` / `LOGIN_MAX_ATTEMPTS` / `LOGIN_LOCK_MS` | 本地 / Vercel | 登录限流窗口、失败阈值与锁定时长 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Vercel | 云端管理员凭据；未配置时非本机登录返回 `503` |
| `ADMIN_SESSION_SECRET` | Vercel | 会话签名密钥；未配置则使用进程内随机密钥，冷启动后需重新登录 |
| `DATABASE_URL` | Vercel | PostgreSQL 连接串；未配置则使用内存存储（重启丢数据） |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `CONTACT_TO` | Node / Vercel | 留言邮件通知，详见下文 |

> 未配置 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 时，云端管理员登录会被拒绝（`503`），公开接口不受影响。

## 上云部署说明（Vercel/Serverless）

完整部署步骤请参阅 [docs/DEPLOY.md](docs/DEPLOY.md)。

- `api/[...route].js` 提供云端 API，支持：
	- 登录/登出、CSRF 校验、账号密码修改
	- 友链申请与审核、文章管理、留言管理、统计接口
	- 审计日志查询与 CSV 导出
	- 健康检查：`GET /api/health`（返回存储模式、凭据来源、是否已配置云端管理员环境变量）
- 生产环境必须配置：
	- `ADMIN_USERNAME`：管理员账号
	- `ADMIN_PASSWORD`：管理员密码
- 强烈建议配置：
	- `ADMIN_SESSION_SECRET`：会话签名密钥；未配置时使用进程内随机密钥，冷启动后管理员需重新登录
- 可选：
	- `DATABASE_URL`：PostgreSQL 连接串；未配置时使用内存存储
- 云端安全策略：
	- 非本机请求（非 `localhost/127.0.0.1/::1`）下，若未配置 `ADMIN_USERNAME` 与 `ADMIN_PASSWORD`，管理员登录会被拒绝（返回 503）。
	- 管理员登录启用限流：10 分钟窗口内连续失败达到 5 次后锁定 15 分钟（返回 429，并带 `Retry-After`）。
	- 登录/CSRF/会话签名均使用常量时间比较；密码哈希默认 600,000 次 PBKDF2-SHA256 迭代。
	- 签名会话 Cookie 绑定当前凭据指纹；修改账号或密码后，旧 Token 自动失效，当前浏览器会收到新 Token。
	- 修改密码要求至少 10 位，且包含大写字母、小写字母、数字、符号中的至少三类。
	- 当配置了上述环境变量后，后台“修改密码/重置默认账号”会被禁用，凭据以环境变量为准。
	- `reset-admin-credentials` 仅允许本机 `localhost` 请求，线上远程请求会被拒绝（返回 403），并清除会话 Cookie。
- 若云平台文件系统为只读，接口会降级为进程内内存存储（实例重启后数据会丢失）。
	- 生产环境建议接入外部持久化（PostgreSQL，或 MySQL / Redis / 云数据库）。

## 留言邮件通知（SMTP）

「联系我」表单会先把留言写入数据库，再尝试用 SMTP 把通知寄到站长邮箱。

1. 复制 `.env.example` 为 `.env`（已被 `.gitignore` 忽略），或直接在 Vercel 配置环境变量：
   `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `CONTACT_TO`
2. QQ 邮箱的 `SMTP_PASS` 要填**授权码**（设置 → 账号 → 开启 POP3/SMTP → 生成授权码），不是 QQ 密码。
3. 本地启动 `server/server.js` 时自动读取根目录 `.env`；Vercel 使用平台环境变量。
4. 未配置 SMTP 时留言照常入库，接口返回 `mailed: false`，页面提示“已保存到站内，可直接发邮件”。
5. 管理员登录后访问 `GET /api/mail-status` 可查看 `configured` 与最近一次发送结果。

## 相关文档

- [docs/STRUCTURE.md](docs/STRUCTURE.md)：目录职责、命名规则、引用方式与旧地址兼容约定。
- [docs/DEPLOY.md](docs/DEPLOY.md)：Vercel / 自有主机部署、环境变量、PostgreSQL 与排障。

---

**YanMo的个人博客**：专注信息安全学习与实践记录。
