# 工具库数据

> 后台「工具库」已接入数据库管理，前台优先读取 `/api/tools`。本文件用于首次启动播种，以及 API 不可用时的静态回退。日常增删改请直接在管理页操作。

工具库页面：`src/pages/tools.html`  
数据文件：`src/data/tools.json`

## 添加一个网盘工具

在 `tools` 数组里追加一个对象：

```json
{
  "id": "nmap",
  "name": "Nmap",
  "category": "网络安全",
  "version": "7.95",
  "size": "28 MB",
  "description": "主机发现、端口扫描与服务识别的经典工具。",
  "glyph": "NM",
  "tone": "green",
  "downloadUrl": "https://nmap.org/download.html",
  "panUrl": "https://pan.baidu.com/s/你的分享链接",
  "panCode": "abcd",
  "source": "官方",
  "updatedAt": "2026-11-25"
}
```

字段说明：

- `panUrl`：网盘分享链接。**只要填写了它，按钮就会自动变成「网盘下载」并优先打开它。**
- `panCode`：网盘提取码。填写后卡片会显示一键复制按钮。
- `downloadUrl`：官方或备用下载地址；没填 `panUrl` 时使用。
- `category`：必须是 `categories` 里已有的分类，或同时在数组里新增分类。
- `glyph` / `tone`：卡片图标文字与配色（blue / cyan / green / orange / purple / gray）。
- `size` / `updatedAt`：显示在卡片底部，可留空。

## 分类

页面顶部的筛选按钮来自 `categories` 数组。新增分类时保留「全部」在第一项，例如：

```json
"categories": ["全部", "计算机网络", "网络安全", "开发环境", "网络代理", "实用工具", "移动应用"]
```

## 说明

- 本站不保存工具文件，只保存索引和链接。
- 百度网盘、夸克网盘等分享页通常不能跨域直链下载，因此按钮打开分享页，提取码可复制。
- 如果换成自己的直链文件地址，也可以直接填在 `panUrl`，按钮同样会打开它。
