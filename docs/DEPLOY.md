# 部署指南

本项目支持两种部署模式：

- **本地/云服务器**：Node.js + Express + SQLite，数据持久化
- **Serverless**：Vercel + 可选 PostgreSQL

静态站点根目录即仓库根目录：页面在 `src/pages/`、样式在 `src/css/`、脚本在 `src/js/`、图片/音频/第三方库在 `assets/`，测试配置在 `config/`；根目录只保留 `package.json`、`vercel.json` 等部署与元文件。完整的目录与引用约定见 [STRUCTURE.md](STRUCTURE.md)。

---

## 本地开发

```bash
cd server
npm install
npm run dev        # nodemon 热重载，监听 :3000
```

访问 http://localhost:3000

---

## 方式一：云服务器部署（数据持久化）

适合需要稳定存储留言、友链、文章的生产场景。

### 前置要求

- Node.js 20+
- 可选：Nginx 反代 + HTTPS

### 步骤

```bash
git clone <your-repo-url>
cd BoKe-main/server
npm install --production
npm start           # node server.js，监听 :3000
```

Nginx 反代示例（`/etc/nginx/sites-available/yanmo`）：

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

数据文件默认路径：`data/blog.db`，可通过环境变量 `DB_PATH` 修改。

管理员凭据：
- 凭据文件：`data/admin-credentials.json`，可通过 `ADMIN_CREDENTIALS_FILE` 指定路径
- 首次启动后通过管理后台 `设置 → 修改密码` 更改默认账号

---

## 方式二：Vercel Serverless 部署

### 前置要求

- Vercel 账号，仓库已导入

### 生产环境管理员凭据（必须）

| 变量名 | 说明 |
|--------|------|
| `ADMIN_USERNAME` | 管理员用户名，必须设置 |
| `ADMIN_PASSWORD` | 管理员密码，必须设置；建议至少 10 位并包含三类字符 |
| `ADMIN_SESSION_SECRET` | Session 签名密钥，强烈建议配置为随机长字符串 |
| `SESSION_TTL_MS` | 可选，会话绝对有效期，默认 12 小时 |
| `PASSWORD_HASH_ITERATIONS` | 可选，PBKDF2 迭代次数，默认 600,000 |
| `LOGIN_WINDOW_MS` / `LOGIN_MAX_ATTEMPTS` / `LOGIN_LOCK_MS` | 可选，登录限流窗口 / 失败阈值 / 锁定时长 |

生成 Session 密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> 未设置 `ADMIN_SESSION_SECRET` 或使用默认值时，API 会使用进程内随机密钥并打印警告：公开接口正常，但管理员会话在实例冷启动后失效，生产环境请显式配置。

### 可选：PostgreSQL 持久化

设置 `DATABASE_URL` 环境变量为 PostgreSQL 连接字符串，API 会自动建表并优先使用数据库存储。不设置则降级为实例内存存储（**重启后数据丢失**）。

### 可选：留言邮件通知（SMTP）

「联系我」表单默认只入库、不发信。要让留言真正发到你的邮箱，需要配置 SMTP：

| 变量名 | 说明 |
|--------|------|
| `SMTP_HOST` | 如 `smtp.qq.com`（QQ 邮箱）/ `smtp.163.com` |
| `SMTP_PORT` | `465`（SSL）或 `587`（STARTTLS） |
| `SMTP_SECURE` | `465` 端口填 `true`；`587` 端口填 `false` |
| `SMTP_USER` | 发信邮箱账号 |
| `SMTP_PASS` | **邮箱授权码**（QQ 邮箱：设置 → 账号 → 开启 POP3/SMTP → 生成授权码），不是登录密码 |
| `CONTACT_TO` | 收信邮箱，留空则默认发给 `SMTP_USER` |

- 本地开发把上面几项写进项目根目录 `.env`（可复制 `.env.example`），`server/server.js` 会自动读取。
- 未配置时留言仍会入库，接口返回 `{ success: true, mailed: false }`，页面会提示"已保存到站内 + 可直接发邮件"。
- 配置后可访问 `GET /api/mail-status`（需管理员登录）确认邮件通道状态与最近一次发送结果。

### 验证部署

| 地址 | 期望返回 |
|------|----------|
| `/api` | `{ "ok": true, "mode": "server-api" }` |
| `/api/health` | `{ "ok": true, "ts": "..." }` |
| 管理后台状态栏 | 显示 `API: SERVER` |

---

## 常见问题

**页面仍显示本地 Mock 数据**
- 强制刷新（Ctrl+F5）
- 打开 DevTools → Application → LocalStorage，确认 `yanmo.site.api.mode.v1` 的值不是 `local`

**登录失败**
- 返回 `503`：未配置 `ADMIN_USERNAME` / `ADMIN_PASSWORD`
- 返回 `429`：触发登录限流（10 分钟内 5 次失败，锁定 15 分钟），响应带 `Retry-After`
- 返回 `401`：用户名或密码错误
- 修改密码返回 `400`：新密码不满足强度要求（至少 10 位，且包含大小写/数字/符号中至少三类）

**重置管理员账号**
- `/api/reset-admin-credentials` 仅允许 localhost 调用（远程访问返回 403）
- 配置了环境变量凭据时，后台改密和重置均被禁用，需直接修改环境变量

**Vercel 数据重启后丢失**
- 当前处于内存存储模式，需接入 PostgreSQL（设置 `DATABASE_URL`）

**提交留言但收不到邮件**
- 先确认已配置 `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` / `CONTACT_TO`（见上文“留言邮件通知”）
- QQ 邮箱必须用**授权码**而不是登录密码；未开启 POP3/SMTP 服务时会被拒绝（`Invalid login`）
- 管理员登录后访问 `/api/mail-status` 查看 `configured` 与 `last_result.error`
- 未配置时留言仍保存在数据库，可在后台“留言管理”查看

---

## 联系

- GitHub: https://github.com/YanMo5
- Email: 3351708803@qq.com
