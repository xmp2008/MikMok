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

## 第二轮需求：自动硬编运行时开关 + 编码质量档位（2026-09-08）

**需求来源**：自动硬编不能占满 NAS CPU（要能随时关）；外出 WiFi 带宽波动
（家宽 ~5MB/s vs 外出 0.5~1MB/s），需要按网络选编码质量。

### 新增行为

| 项 | 说明 |
| --- | --- |
| 自动转码开关 | `transcodeAutoEnabled`（默认开）。关闭后：新视频不再入队、已排队任务不再启动、运行中判断处直接回退 `needs_transcode`——ffmpeg/QSV 完全不会被拉起。`TRANSCODE_ENABLED=0` 仍然全局强制关闭（优先级最高）。 |
| 质量档位 | `transcodeQuality`：`high`/`medium`（默认）/`low`。QSV 用 VBR 码率目标（6M / 2.5M / 1M avg，配 maxrate/bufsize）+ preset（veryslow/veryfast/veryfast）+ 限高（原画/720p/480p，等比 `scale=-2:-2`/`scale=-4:-2` CPU 侧缩放后 hwupload）+ async_depth（4/4/2）；libx264 同码率目标镜像（`-b:v`/`-maxrate`/`-bufsize`）。 |
| 持久化 | 两个偏好存 `app_state` KV 表（`preferences.transcode_auto_enabled` / `preferences.transcode_quality`），运行时生效，**无需重启容器**。 |
| API | `PATCH /api/preferences` 新增 `transcodeAutoEnabled: boolean`、`transcodeQuality: "high"\|"medium"\|"low"`；`GET /api/health` 新增上报 `transcodeAutoEnabled`/`transcodeQuality`。 |
| UI | Settings 页新增 "Transcoding" 卡片：Auto transcode 开关 + Transcode quality 下拉（High 原画/Medium 720p/Low 480p），样式沿用现有 settings-switch/settings-select。 |

### 质量档位设计依据（真机二分定案，2026-09-09）

**Jasper Lake VDEnc 的质量控制只能走 VBR 码率目标**——真机二分实测：

- ❌ `-global_quality`（ICQ 模式）：`MFX_ERR_INVALID_VIDEO_PARAM (-15)`，
  编码器初始化直接失败（low_power=1 的 VDEnc 路径不支持 ICQ）。
- ❌ `-cqp` / `-qp_i`/`-qp_p`（CQP 模式）：Debian ffmpeg 5.1 的 h264_qsv
  未编译这些简写选项（`Unrecognized option`）。
- ✅ `-b:v` + `-maxrate` + `-bufsize`（VBR）：三档全部通过，产物 mp4 正常。

**码率定档**（对齐实际上行带宽）：

| 档位 | 分辨率 | avg / max / buf | 均码折算 |
| --- | --- | --- | --- |
| high | 原画 | 6M / 8M / 12M | ~750 KB/s（家宽 5MB/s 富余） |
| medium | ≤720p | 2.5M / 3.5M / 6M | ~310 KB/s（500KB/s 弱上行可放） |
| low | ≤480p | 1M / 1.4M / 2.4M | ~125 KB/s（最差网络兜底） |

- 缩放在 CPU 侧 `scale` 完成后 `hwupload`（VDEnc 接受 sw 输入）：N5105 做
  一次缩放远比软编便宜，且避免 QSV 缩放 VPP 在 low_power 路径的能力差异。
- libx264 路径与 QSV 用同一套码率目标（放弃 CRF），保证双后端档位语义一致。

### 改动文件（第二轮）

| 文件 | 改动 |
| --- | --- |
| `backend/src/services/preferences/preferencesService.ts` | 新增 `transcodeAutoEnabled`/`transcodeQuality` 偏好（app_state 持久化） |
| `backend/src/routes/preferences.ts` | PATCH schema 接收两个新字段 |
| `backend/src/services/media/transcodeService.ts` | 质量档位映射表；QSV/libx264 参数按档位构造；`resolveRuntimeOptions()` 读取运行时偏好 |
| `backend/src/services/jobs/jobWorker.ts` | 开关动态化：`isTranscodingActive()` = env 总闸 AND 运行时偏好；enqueue/pump/执行三处生效；转码按当前档位执行 |
| `backend/src/routes/health.ts` | 上报运行时开关与档位 |
| `frontend/src/store/uiStore.ts` | 偏好类型/默认值/同步（沿用 PATCH /preferences 通道） |
| `frontend/src/pages/Settings.tsx` | Transcoding 卡片（开关+档位下拉+编码器提示） |
| `backend/Dockerfile` | runtime 层补 bookworm non-free 源（修 `intel-media-va-driver-non-free has no installation candidate`） |

### 设计红线（新增两条）

4. **开关语义**：运行时开关只挡"自动"转码；`TRANSCODE_ENABLED=0` 仍是最高
   优先级总闸。关闭开关时绝不产生新的 ffmpeg 进程。
5. **档位即参数**：档位只改编码参数（质量/预设/分辨率上限），不改目标容器、
   封装与 faststart 行为；QSV 失败不回退软编的红线延续。

