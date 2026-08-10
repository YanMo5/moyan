# 部署指南

本项目支持两种部署模式：

- **本地/云服务器**：Node.js + Express + SQLite，数据持久化
- **Serverless**：Vercel + 可选 PostgreSQL

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

- Node.js 18+
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

数据文件默认路径：`server/blog.db`，可通过环境变量 `DB_PATH` 修改。

管理员凭据：
- 凭据文件：`admin_credentials.json`（根目录），可通过 `ADMIN_CREDENTIALS_FILE` 指定路径
- 首次启动后通过管理后台 `设置 → 修改密码` 更改默认账号

---

## 方式二：Vercel Serverless 部署

### 前置要求

- Vercel 账号，仓库已导入

### 必须设置的环境变量（Production）

| 变量名 | 说明 |
|--------|------|
| `ADMIN_USERNAME` | 管理员用户名 |
| `ADMIN_PASSWORD` | 管理员密码 |
| `ADMIN_SESSION_SECRET` | Session 签名密钥，**必须**为随机长字符串 |

生成 Session 密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> 未设置 `ADMIN_SESSION_SECRET` 或使用默认值时，API 会在启动时抛出 FATAL 错误拒绝运行。

### 可选：PostgreSQL 持久化

设置 `DATABASE_URL` 环境变量为 PostgreSQL 连接字符串，API 会自动建表并优先使用数据库存储。不设置则降级为实例内存存储（**重启后数据丢失**）。

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
- 返回 `429`：触发登录限流（10 分钟内 5 次失败，锁定 15 分钟）
- 返回 `401`：用户名或密码错误

**重置管理员账号**
- `/api/reset-admin-credentials` 仅允许 localhost 调用（远程访问返回 403）
- 配置了环境变量凭据时，后台改密和重置均被禁用，需直接修改环境变量

**Vercel 数据重启后丢失**
- 当前处于内存存储模式，需接入 PostgreSQL（设置 `DATABASE_URL`）

---

## 联系

- GitHub: https://github.com/YanMo5
- Email: 3351708803@qq.com
