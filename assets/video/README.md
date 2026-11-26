# Site-wide hero video

首页 Hero 现在使用 8 段视频轮播，每段完整播放一遍后直接硬切到下一段，不做叠化也不加黑场，避免闪屏和双画面/双字幕叠影；3 段人生格言短片与 5 段风景/夜景交替出现。

## 轮播场景

- `hero-loop.mp4`：樱花隧道，春樱场景（SCENE 01），1920×1080，来自 Coverr。
  - 来源：https://coverr.co/videos/sunlit-cherry-blossom-tunnel-lined-with-falling-petals
  - Coverr License：可免费用于个人/商业项目，无需署名。
- `hero-motivation-1-hq.mp4`：12 秒列车单场景励志短片，字幕「只要你在进步」等，1920×1080 / 30fps，SCENE 02。
- `hero-forest-hq.mp4`：山湖竹筏，SCENE 03，1920×1080 / 30fps / 约 6.3Mbps，Mixkit #1218。
- `hero-motivation-2-hq.mp4`：自制 12 秒励志短片，篝火单场景，字幕「把夜走完，天就亮了」等，1920×1080 / 30fps / 约 6.2Mbps，SCENE 04。
- `hero-ocean.mp4`：海岸航拍，SCENE 05，Mixkit #1954。
- `hero-motivation-3.mp4`：自制 12 秒励志短片，列车 / 樱花 / 海岸，字幕「先出发，再找答案」等，SCENE 06。
- `hero-campfire.mp4`：篝火，SCENE 07，Mixkit #1243。
- `hero-train.mp4`：夜间列车，SCENE 08，Mixkit #1606。
- `hero-*-poster.jpg`：各场景海报，视频加载前 / 减少动态偏好时显示。
- `hero-loop.webm`：早期 5 秒抽象氛围循环，仅保留作 WebM 回退素材。
- 新增 Mixkit 素材均使用 Mixkit Free License，可免费用于个人/商业项目，无需署名；直链为 `https://assets.mixkit.co/videos/<id>/<id>-720.mp4`。
- 3 段 `hero-motivation-*.mp4` 是项目内用 Canvas + MediaRecorder 自制的 12 秒 H.264 短片，每段含 3 句中英字幕，无外部版权。
- 所有轮播视频统一为 **30fps / 1280×720 / H.264 / faststart**；原始 24fps 素材已用 `minterpolate` 补帧到 30fps，避免 60Hz 屏幕上的 3:2 抖动。

## 替换 / 新增场景

1. 推荐 **1280×720 或 1920×1080**，6–12 秒循环，无音轨。
2. 编码为 **MP4 / H.264**，单个尽量控制在 **6MB 以内**。
3. 新增视频后在 `src/pages/index.html` 的 `.site-video-bg` 中复制一个 `<video class="site-video hero-video">`，填写 `data-badge` 场景标签；格言字幕直接烧录在励志短片中。
4. 替换现有场景时保留文件名即可。
5. 建议同步生成同尺寸海报，避免切换时闪黑。

视频会以 `object-fit: cover` 作为固定全屏背景，滚动到页脚仍持续播放；画面主体尽量放中央偏左/右侧，给中央标题留出暗部。
