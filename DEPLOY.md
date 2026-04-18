# 网站部署指南

本项目支持两种部署方式：

1. 服务器部署（Python 服务，SQLite 持久化）
2. Serverless 部署（Vercel API 路由）

## 本地开发

1. 克隆仓库
2. 进入项目根目录
3. 启动：

```bash
python server/server.py
```

4. 访问：http://localhost:3000

## 方式一：云服务器部署（推荐持久化）

适合需要稳定持久化数据（留言、友链、文章、审计日志）的场景。

### 步骤

1. 准备一台 Linux 服务器（Ubuntu/CentOS 均可）
2. 安装 Python 3
3. 拉取仓库并启动：

```bash
git clone <your-repo-url>
cd BoKe-main
python server/server.py
```

4. 使用 Nginx 反向代理到 3000 端口（可配 HTTPS）

## 方式二：Vercel Serverless 部署

项目已提供以下云端文件：

- api/index.js
- api/[...route].js
- vercel.json

### 部署步骤

1. 将仓库导入 Vercel
2. 设置环境变量（Production 环境）：

- ADMIN_USERNAME（建议必填）
- ADMIN_PASSWORD（建议必填）
- ADMIN_SESSION_SECRET（强烈建议必填，随机长字符串）

说明：非本机访问下，如果未配置 ADMIN_USERNAME / ADMIN_PASSWORD，管理员登录会被后端拒绝（503）。

3. 部署后访问站点并验证：

- /api 返回 mode: server-api
- /api/health 返回 ok: true，且可查看 storage_mode / credentials_mode
- 管理后台显示 API: SERVER

### 重要说明

- Serverless 环境可能是只读文件系统。
- 当文件系统不可写时，api/[...route].js 会降级为实例内存存储。
- 实例重启后内存数据会丢失。

生产环境请接入外部数据库（如 PostgreSQL/MySQL/云数据库）。

## 常见问题

### 1. 线上仍然是本地数据

- 强刷浏览器缓存（Ctrl+F5）
- 确认 localStorage 中 yanmo.site.api.mode.v1 不是 local
- 确认后台显示 API: SERVER

### 2. 登录总失败

- 检查 ADMIN_USERNAME / ADMIN_PASSWORD 是否正确配置
- 检查 ADMIN_SESSION_SECRET 是否为空
- 若返回 503，请优先检查是否遗漏了 ADMIN_USERNAME / ADMIN_PASSWORD
- 若返回 429，说明触发登录限流锁定（10 分钟窗口 5 次失败，锁 15 分钟）

### 3. 无法重置默认账号

- 云端远程访问下 `reset-admin-credentials` 被限制为仅 localhost 调用（403）
- 配置了 ADMIN_USERNAME / ADMIN_PASSWORD 时，后台改密与重置同样会被禁用

### 4. 数据重启后丢失

- 你当前处于 Serverless 内存存储降级模式
- 需要切换到外部数据库持久化

## 技术支持

- GitHub: https://github.com/YanMo5
- Email: 3351708803@qq.com
