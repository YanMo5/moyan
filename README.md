# YanMo的个人博客

一个基于 HTML、CSS、JavaScript 与 Node.js（Express + SQLite）的个人博客项目，聚焦信息安全学习记录与内容展示。

> 最近一次安全与质量审计：[docs/AUDIT-2026-11-25.md](docs/AUDIT-2026-11-25.md)。
>
> 部署到自己的服务器或 Vercel：[部署.md](部署.md)。

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
	- 日常：独立的照片流页面，展示照片/证书与感悟，支持灯箱查看。
	- 文章详情：阅读正文，异常参数时有回退机制保障可访问性。
	- 关于/联系：展示作者信息与联系表单。
	- 留言板：公开访客日志 + 「写留言」入口；表单独立到 `/src/pages/message-apply.html`，提交后由本地规则自动检测不当言论与垃圾信息，通过后立即展示。
	- 友链页：展示通过审核的友链信息与头像。
- 后台管理能力：
	- 文章管理：新增、编辑、删除与发布内容维护；支持可选封面图上传（自动压缩为 WebP），无封面自动使用分类色渐变占位。
	- 日常管理：上传照片、自动压缩、填写感悟、编辑说明、查看与删除日常。
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
- 全站视觉升级：新增 `aurora.css` 视觉层，统一首页双栏 Hero、终端状态卡、文章编辑式卡片、详情封面、表单控件、登录页、页脚与移动端导航；并加入 Hero 极光渐变描边、分类色文章卡片、页脚 ghost wordmark 等细节，暗色 / 亮色 / 赛博皮肤均有对应回退。
- 页面识别系统：文章、日常、联系、留言、友链分别使用独立的页面强调色与编号 watermark；页面标题统一为中文第一行、英文第二行居中，移动端自动缩小。
- 首页视频 Hero：8 段场景轮播（春樱 / 慢一点 / 秋山 / 夜路 / 海岸 / 起伏 / 篝火 / 末班车），每段完整播放一遍后直接硬切到下一段，不做叠化也不加黑场，避免闪屏、双画面和双字幕；其中 3 段是自制的 12 秒电影感励志短片（每段 3 句中英字幕），5 段是风景/夜景；全部统一 30fps，避免 24fps 在 60Hz 屏幕上的抖动。切后台暂停，`prefers-reduced-motion` 下只显示海报。视频与来源见 `assets/video/README.md`。
- 关于二级导航：`随便逛逛`（随机打开一篇文章）、`隐私协议`（独立文档）、`关于本人`（关于页简介锚点）。
- 工具库：`/src/pages/tools.html`，支持搜索、分类筛选、网盘链接与提取码复制；后台可直接增删改工具并填写网盘/提取码；`src/data/tools.json` 用于首次播种与接口不可用时的静态回退。
- 后台工具库：管理页新增工具库增删改与网盘/提取码字段，接口为 `GET /api/tools` 与受管理员会话/CSRF 保护的增删改接口；文章、日常、留言、友链、审计、账户与页面入口统一收进后台索引。
- 统一参考式页脚：居中社交图标、四列「资产测绘 / 云沙箱 / 网络检测 / 本站协议」链接、底部版权与快捷导航；公共页面由 `ux-enhancements.js` 自动注入。协议入口分别指向 `src/pages/privacy.html`、`cookies.html`、`version.html`；`policy.html` 作为协议目录页。
- 页面切换动画：全屏过渡层中央使用站点头像 + 手写签名作为个人标识，替代通用字母 Logo；页面名称改为中文友好标签，状态文案使用「正在翻页 / 下一站 / 快到了」等；首次约 1.05 秒、后续约 0.85 秒，100% 后短暂停留再进入。支持 Esc 取消，浏览器返回自动复位；减少动态偏好下直接跳转。
- 日常独立页面：顶部导航「日常」进入独立的照片流，与文章系统分离；后台可上传图片、自动压缩为 WebP、填写/修改感悟、查看/删除已发布日常，前台支持网格浏览与灯箱查看。
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
- 性能优化：Node 静态资源与 API 启用 gzip；默认使用系统字体，Google 字体仅在赛博皮肤下按需加载，避免国内网络阻塞首屏。
- SEO 基础：页面补充 description / Open Graph / Twitter Card / RSS 自动发现，服务端提供 `/robots.txt`、`/sitemap.xml`、`/rss.xml`，并使用 1200×630 品牌分享图。
- 首页内容密度：新增 `LATEST_WRITEUPS` 最新文章橱窗；CVE 面板使用 30 分钟本地缓存、旧数据降级和示例数据兜底，避免长时间停留在查询状态。

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
- 留言自动检测：本地规则拦截辱骂、威胁、仇恨、成人垃圾与链接刷屏；不会误伤“攻击面 / 漏洞 / 渗透 / 杀进程”等安全术语，命中后返回 400 并提示修改。
- 全接口输入防护：统一长度/控制字符/邮箱/HTTP URL/图片 Data URL 校验，记录 ID 数值化，JSON 体积上限与解析错误统一返回 JSON；留言、联系、友链申请加入按 IP 的速率限制。
- 链接探活防护：要求有效签名管理员会话，并在 DNS 解析与重定向前校验目标，阻断内网、回环、IMDS、ULA、非标准端口与协议跳转（SSRF）。
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
| 日常 | `/src/pages/daily.html` | — |
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
- 当前为 4 个测试文件、91 个用例；覆盖服务端认证/权限、API、邮件、友链检查、工具库 CRUD；测试使用临时数据库与临时凭据文件，结束后自动清理，不会污染 `data/`。

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
│   │   ├── daily.html                    # 日常照片流（独立于文章）
│   │   ├── tools.html                    # 工具库（搜索/分类/网盘下载）
│   │   ├── post.html                     # 文章详情页（模板）
│   │   ├── contact.html                  # 联系页
│   │   ├── guestbook.html                # 留言板页面
│   │   ├── links.html                    # 友链展示页
│   │   ├── link-apply.html               # 友链申请页（含头像上传/裁剪）
│   │   ├── message-apply.html            # 留言申请页
│   │   ├── policy.html                   # 网站协议目录页
│   │   ├── privacy.html                  # 隐私协议草案
│   │   ├── cookies.html                  # Cookie 协议草案
│   │   ├── version.html                  # 版本协议与变更记录
│   │   ├── admin.html                    # 管理员登录页
│   │   └── admin-dashboard.html          # 管理后台页面
│   ├── css/                              # 样式（URL: /src/css/*.css）
│   │   ├── styles.css                    # 主样式：布局、组件、响应式等
│   │   ├── beautify.css                  # 视觉增强样式：特效与细节修饰
│   │   ├── music-box.css                 # 音乐盒样式
│   │   ├── theme-lumina.css              # Lumina 主题基础层
│   │   ├── aurora.css                    # 视觉系统 v3：首页、文章、详情、表单、登录
│   │   ├── legal.css                     # 协议文档排版
│   │   └── tools.css                     # 工具库页面样式
│   ├── data/                             # 静态数据（URL: /src/data/*.json）
│   │   ├── tools.json                    # 工具库索引与网盘链接
│   │   └── README.md                     # 工具数据填写说明
│   └── js/                               # 前端脚本（URL: /src/js/*.js）
│       ├── date-utils.js                 # 日期工具
│       ├── home-page.js                  # 首页逻辑
│       ├── local-api.js                  # 本地模拟 API（local/server 模式）
│       ├── music-box.js                  # 音乐盒
│       ├── palette-manager.js            # 配色管理
│       ├── theme-boot.js                 # 主题预加载（防闪烁）
│       ├── tools-page.js                 # 工具库搜索/筛选/网盘下载
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
| `SITE_URL` | 本地 Node / Vercel | 公开站点地址，用于 sitemap / RSS 绝对链接；不填则按请求 Host 推断 |
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
