# QSV 硬件转码需求说明（TRANSCODE_CODEC=qsv）

> 分支：`feat/qsv-hw-transcode` · 基线：v0.2.1 (901381a) · 2026-09-09

## 需求背景（为什么要硬编）

部署环境为 QNAP NAS（Intel N5105，Jasper Lake，4 核小主机），同时承担下载、
文件服务等任务。上游默认的 `libx264 -preset veryfast` 软件转码会吃满全部
4 个核心，拖垮整机。**该环境禁止一切软件编码。**

播放端的真实网络条件：

- 家宽上行约 **5 MB/s**，且常被其他任务占满；
- 外出场景常用 Wi-Fi/蜂窝，实测 **0.5~1 MB/s**。

因此库内 HEVC/其他非直连格式的视频必须转成
**H.264 (AVC) + AAC in MP4** 才能对外直连播放——这正是
`playbackPolicy.ts` 的直连判定条件。转码必须由 GPU 完成。

## 硬件验证结论（Jasper Lake）

N5105 的 iGPU（UHD Graphics，32EU）经 `vainfo` 实测**只暴露
`VAEntrypointEncSliceLP`**（VDEnc 低功耗编码入口），没有传统
`EncSlice`。因此 QSV 必须以 **`low_power=1`** 初始化：

```
ffmpeg -init_hw_device qsv=hw:low_power=1 -i in \
  -vf format=nv12,hwupload=extra_hw_frames=64 \
  -c:v h264_qsv -preset veryfast -global_quality 23 \
  -c:a aac -f mp4 -movflags +faststart out.mp4
```

已在目标机上用 jellyfin-ffmpeg 实测编码成功。

## 改动内容

| 文件 | 改动 |
| --- | --- |
| `backend/src/config/env.ts` | 新增 `TRANSCODE_CODEC`（`qsv`/`libx264`，默认 `libx264` 保持上游行为）与 `TRANSCODE_QSV_DEVICE` |
| `backend/src/services/media/transcodeService.ts` | 按 codec 构造 ffmpeg 参数；QSV 路径用 `low_power=1` VDEnc 初始化 + `hwupload`；**失败绝不静默回退软编**，配置类错误直接失败并给出修复指引 |
| `backend/Dockerfile` | 运行时装 `intel-media-va-driver-non-free`；修复 CMD 相对路径在 /app 工作目录下失效的 bug |
| `stacks/docker-compose.yml` | 透传 `/dev/dri/renderD128`；新增两个环境变量 |
| `backend/src/routes/health.ts` | 健康检查上报当前转码 codec |
| `.dockerignore` | 新增，缩小构建上下文 |

## 设计红线

1. **严禁软编**：`TRANSCODE_CODEC=qsv` 时任何 QSV 初始化/编码失败都以
   不可重试错误终结任务，明确提示检查设备透传/驱动，绝不静默退回
   `libx264`（软编会拖垮弱 CPU 的 NAS 主机）。
2. **上游兼容**：不设 `TRANSCODE_CODEC` 时行为与上游完全一致。
3. 仅改动视频编码路径；音频（AAC）、封装（mp4 faststart）、缩略图等
   逻辑不变。
