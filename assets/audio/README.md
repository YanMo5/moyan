# assets/audio/ — 音乐盒音轨目录

音乐盒（`src/js/music-box.js`）的曲目来自本目录下的 `playlist.json`，音频文件也放在本目录。

## 自带示例

| 文件 | 说明 |
| --- | --- |
| `demo-lumina-drift.wav` | 内置示例：A 小调铺底 pad（32 秒） |
| `demo-terminal-rain.wav` | 内置示例：雨声铺底 + 水滴（28 秒） |

两个示例由脚本合成（纯正弦 + 噪声），可直接播放，也可随时替换。

## 添加一首曲子

1. 把文件（建议 `.mp3`，128kbps 以上；`.ogg` / `.m4a` / `.wav` 也可）复制到本目录，例如 `night-drive.mp3`。
2. 在 `assets/audio/playlist.json` 的 `tracks` 数组里登记：

```json
{
  "title": "显示名称",
  "artist": "作者 / 来源",
  "src": "/assets/audio/night-drive.mp3"
}
```

`src` 写站点根路径（以 `/` 开头），也支持完整的 `https://` 外链
（外链需在 `vercel.json` 的 CSP `media-src` 白名单内 —— 目前已放行 `https:`）。

## 说明

- 页面不自动播放（遵守浏览器策略），首次点开播放器需手动点 ▶。
- 文件缺失时该曲目会被标记为不可用并自动跳到下一首，其余功能不受影响。
- `tracks` 为空时，播放器仍可使用内置「雨声」环境音（Web Audio 实时合成，无需文件）。
- 音频元素是 `preload="none"`，不会拖慢首屏；建议单曲控制在 5 MB 以内。
