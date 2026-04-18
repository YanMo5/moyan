# YanMo的个人博客

一个基于 HTML、CSS、JavaScript 与 Python（SQLite）的个人博客项目，聚焦信息安全学习记录与内容展示。

## 主要特点

### 视觉与交互
- 赛博风格主题，包含霓虹色、高对比和动效元素。
- 桌面与移动端响应式布局，兼顾大屏阅读与小屏触控。
- 统一导航交互、滚动动画与状态提示，页面体验一致。
- 关键操作具备反馈（成功/失败提示、按钮状态变化、加载过程可见）。

### 内容与页面
- 前台完整内容链路：
	- 首页：展示博客定位与最新内容入口。
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
- Python 后端（`server/server.py`）作为主服务，负责静态资源与 API。
- Node 后端（`server/server.js`）作为备用实现，接口行为保持对齐。
- SQLite 持久化（`blog.db`），用于文章、留言、友链等数据存储。
- 本地模拟 API（`js/local-api.js`）支持 `local/server` 模式切换：
	- `local`：前端本地模拟，适合离线开发与静态调试。
	- `server`：请求真实后端，适合联调与真实数据验证。

### 最近更新（关键）
- 管理员支持修改账号和密码。
- 新增本机可用的管理员应急重置接口（重置为 `admin/admin`）。
- 友链头像上传优化：
	- 统一 1MB 限制（前后端规则一致）。
	- 上传前自动压缩与自动裁剪，降低大图失败率。
	- 支持手动裁剪取景（可调缩放与位置）。
	- 统一导出 WebP，兼顾体积与清晰度。
- 友链与后台头像样式统一为圆形展示。

### 安全与稳定性
- 管理员凭据采用文件持久化，兼容历史密码文件读取。
- 提供本机应急重置机制，降低忘记密码导致的维护阻塞。
- 上传链路包含大小校验、格式处理与失败提示，避免脏数据入库。
- 本地模拟与真实后端接口行为尽量一致，减少“开发可用、上线异常”的偏差。

## 技术栈

- 前端：HTML5、CSS3、JavaScript
- 后端：Python 3（`http.server` 扩展）、Node.js（备用实现）
- 数据库：SQLite

## 快速启动

1. 安装 Python 3。
2. 进入项目根目录。
3. 启动服务：
	 - `python server\server.py`
4. 访问：
	 - 网站首页：`http://localhost:3000`
	 - 管理登录：`http://localhost:3000/pages/admin.html`

## 管理员账号

- 默认账号：`admin`
- 默认密码：`admin`
- 凭据文件：
	- `admin_credentials.json`
	- `admin_password.txt`（兼容）

> 如忘记密码，可在后台“账户设置”中使用本机应急重置功能（需确认口令）。

## 项目结构（当前）

```text
BoKe-main/                                # 项目根目录
├── css/                                  # 样式目录
│   ├── styles.css                        # 主样式：布局、组件、响应式等
│   └── beautify.css                      # 视觉增强样式：特效与细节修饰
├── js/                                   # 前端脚本目录
│   ├── local-api.js                      # 本地模拟 API（支持 local/server 模式）
│   └── ux-enhancements.js                # 通用交互增强脚本
├── pages/                                # 业务页面目录
│   ├── index.html                        # 首页
│   ├── about.html                        # 关于页
│   ├── articles.html                     # 文章列表页
│   ├── post.html                         # 文章详情页
│   ├── contact.html                      # 联系页
│   ├── guestbook.html                    # 留言板页面
│   ├── links.html                        # 友链展示页
│   ├── link-apply.html                   # 友链申请页（含头像上传/裁剪）
│   ├── message-apply.html                # 留言申请页
│   ├── admin.html                        # 管理员登录页
│   └── admin-dashboard.html              # 管理后台页面
├── api/                                  # 无服务器/代理场景下的接口目录
│   ├── index.js                          # API 入口文件
│   └── [...route].js                     # 动态路由分发文件
├── server/                               # 后端服务目录
│   ├── server.py                         # Python 主后端（推荐）
│   ├── server.js                         # Node 备用后端
│   └── package.json                      # Node 依赖与脚本配置
├── index.html                            # 根路径首页入口
├── admin.html                            # 根路径管理登录入口（跳转/兼容）
├── admin-dashboard.html                  # 根路径后台入口（跳转/兼容）
├── link-apply.html                       # 根路径友链申请入口（跳转/兼容）
├── blog.db                               # SQLite 数据库文件
├── views.txt                             # 访问统计存储文件
├── admin_credentials.json                # 管理员账号密码主凭据文件
├── admin_password.txt                    # 历史兼容密码文件
└── README.md                             # 项目说明文档
```

## 上云部署说明（Vercel/Serverless）

- `api/[...route].js` 已从占位接口改为可用云端 API，支持：
	- 登录/登出、CSRF 校验、账号密码修改
	- 友链申请与审核、文章管理、留言管理、统计接口
	- 审计日志查询与 CSV 导出
	- 健康检查：`GET /api/health`（返回存储模式、凭据来源、是否已配置云端管理员环境变量）
- 推荐配置环境变量：
	- `ADMIN_USERNAME`：管理员账号（可选）
	- `ADMIN_PASSWORD`：管理员密码（可选，建议配置）
	- `ADMIN_SESSION_SECRET`：会话签名密钥（强烈建议配置）
- 云端安全策略：
	- 非本机请求（非 `localhost/127.0.0.1/::1`）下，若未配置 `ADMIN_USERNAME` 与 `ADMIN_PASSWORD`，管理员登录会被拒绝（返回 503）。
	- 管理员登录启用限流：10 分钟窗口内连续失败达到 5 次后锁定 15 分钟（返回 429）。
	- 当配置了上述环境变量后，后台“修改密码/重置默认账号”会被禁用，凭据以环境变量为准。
	- `reset-admin-credentials` 仅允许本机 `localhost` 请求，线上远程请求会被拒绝（返回 403）。
- 若云平台文件系统为只读，接口会降级为进程内内存存储（实例重启后数据会丢失）。
	- 生产环境建议接入外部持久化（如 PostgreSQL / MySQL / Redis / 云数据库）。

---

**YanMo的个人博客**：专注信息安全学习与实践记录。
