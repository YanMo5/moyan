# 目录结构与规范

本文约定仓库的目录职责、文件命名与引用方式。新增页面、脚本、样式或资源时请遵循本文。

## 1. 目录职责

| 目录 | 职责 | 是否对外可访问 |
| --- | --- | --- |
| `src/pages/` | 业务页面（HTML） | 是，URL 前缀 `/src/pages/` |
| `src/css/` | 一级样式（布局、皮肤、组件） | 是，URL 前缀 `/src/css/` |
| `src/js/` | 前端脚本（原生 ES5/ES2017，无打包） | 是，URL 前缀 `/src/js/` |
| `assets/images/` | 图片（头像、Logo 等） | 是，URL 前缀 `/assets/images/` |
| `assets/audio/` | 音乐盒音轨与 `playlist.json` | 是，URL 前缀 `/assets/audio/` |
| `assets/vendor/` | 第三方库（本地化，不走上游 CDN） | 是，URL 前缀 `/assets/vendor/` |
| `api/` | Vercel Serverless 接口 | 否（仅平台函数） |
| `server/` | 本地后端（Node.js + Express + SQLite） | 否 |
| `lib/` | Node 共享模块（如邮件发送） | 否 |
| `data/` | 运行时持久化数据（数据库、凭据、计数） | 否（禁止前端引用） |
| `docs/` | 部署、结构等文档 | 否 |
| `tests/` | Vitest 测试 | 否 |
| `config/` | 构建与测试配置（`vitest.config.js`） | 否 |

站点根目录即仓库根目录：`src/`、`assets/` 由本地服务白名单暴露；`data/`、`server/`、`tests/` 等不属于前端引用范围，本地静态服务不会暴露，Vercel 路由也显式拦截。

后端统一使用 Node.js（Express）：本地入口为 `server/server.js`，云端入口为 `api/[...route].js`，两条路径的接口行为保持一致。

## 2. 命名规范

- 页面、样式、脚本统一使用 **kebab-case 小写**，不含空格与中文，例如 `link-apply.html`、`music-box.css`、`theme-boot.js`。
- 页面名与功能一致；后台页面以 `admin` 开头：`admin.html`、`admin-dashboard.html`。
- 第三方库放入 `assets/vendor/`，文件名带版本号：`<库名>-<版本>.min.js|css`，例如 `marked-12.0.0.min.js`。
- 文档使用 `UPPER_SNAKE.md`：`README.md`、`DEPLOY.md`、`STRUCTURE.md`；音频等子目录的说明文件沿用 `README.md`。
- Node 脚本与测试使用 kebab-case，测试文件统一 `*.test.js`。
- 构建/测试配置放在 `config/`，文件名同样用 kebab-case，例如 `vitest.config.js`。
- 运行时数据文件使用小写 kebab-case（`cloud-data.json`、`admin-credentials.json`）。

## 3. 引用规范

1. **一律使用站点根相对路径**（以 `/` 开头），禁止 `../` 或 `./` 相对引用。页面全部位于 `/src/pages/`，相对层级不会带来好处，只会增加迁移成本。
2. 页面之间跳转：`/src/pages/<页面>.html`，例如 `/src/pages/articles.html`。
3. 样式与脚本：`/src/css/<文件>.css`、`/src/js/<文件>.js`。
4. 静态资源：`/assets/images/...`、`/assets/audio/...`、`/assets/vendor/...`。
5. 接口请求：统一 `/api/...`，不要在页面里拼接后端源站地址。
6. 新增静态资源目录时，若需要独立缓存策略，同步在 `vercel.json` 的 `headers` 中登记。
7. 前端脚本加载顺序保持：`utils.js` → `palette-manager.js` → `music-box.js`（`defer`）→ `ux-enhancements.js` → `local-api.js` → 页面自身脚本。

## 4. 静态资源与运行时数据

- `assets/` 只放可公开、可缓存的资源，允许被 `<link>` / `<script>` / `<img>` / `fetch` 直接引用。
- `data/` 只允许后端读写；数据库、管理员凭据、浏览量计数不得出现在页面或脚本的 URL 中。
- 音乐盒播放列表固定为 `assets/audio/playlist.json`，由 `src/js/music-box.js` 的 `PLAYLIST_URL` 读取；曲目 `src` 使用 `/assets/audio/<文件>`。

## 5. 根目录与兼容入口

根目录只保留包管理、部署与仓库元文件：`package.json`、`package-lock.json`、`vercel.json`、`.gitignore`、`.env.example`、`README.md`、`LICENSE`。页面、样式、脚本、资源、配置、后端一律归入 `src/`、`assets/`、`config/`、`server/`、`api/`、`lib/`、`docs/`、`tests/`，**不要新增根目录 HTML**。

- `/` 返回 `src/pages/loading.html`（原根目录 `index.html` 已归入 `src/pages/`），加载完成后跳转 `/src/pages/index.html`。
- `/index.html`、`/admin.html`、`/admin-dashboard.html`、`/link-apply.html` 是旧地址：Vercel 用 `routes` 重写到 `/src/pages/` 对应页面，本地 Node 服务返回 301 跳转。
- `/pages/*` 由 `vercel.json` 重写到 `/src/pages/*`；本地 Node 服务返回 302 跳转到 `/src/pages/*`。
- `/post/<id>` 由 `vercel.json` 与 `server/server.js` 统一映射到 `/src/pages/post.html`；`/post` 与 `/post/<非数字>` 回文章列表。

> `/` 由服务端路由提供。若使用第三方静态预览（如 VS Code Live Server），请直接访问 `/src/pages/loading.html` 或 `/src/pages/index.html`；完整的入口与旧地址行为请用 `npm start` 启动本地 Node 服务。

## 6. 新增页面清单

1. 在 `src/pages/` 新建 kebab-case 页面，引用统一样式与脚本（根相对路径）。
2. 若需要导航入口，同时更新 `src/js/home-page.js` 的导航映射与各页面导航栏。
3. 若页面需要新的样式/脚本，分别放入 `src/css/`、`src/js/`，不要放在页面同级目录。
4. 若页面需要新的图片/音频，放入 `assets/` 对应子目录。
5. 更新 `README.md` 的项目结构说明（如有目录变化）。

## 7. 自检命令

```powershell
npm test                                              # Vitest 全量测试
node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8'))"   # 校验 Vercel 配置
node --check server/server.js                         # Node 后端语法
```

检查是否残留旧路径引用：

```powershell
Get-ChildItem -Recurse -File |
  Where-Object { $_.FullName -notmatch '\\(node_modules|\.venv|\.git|assets\\vendor)\\' } |
  Select-String -Pattern '(?<!/src)/(pages|css|js|vendor|audio)/'
```
