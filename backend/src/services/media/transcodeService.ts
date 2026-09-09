import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink, rename } from "node:fs/promises";
import { promisify } from "node:util";

import { env } from "../../config/env.js";
import { preferencesService } from "../preferences/preferencesService.js";
import { uploadStoreService } from "../storage/uploadStore.js";

const execFileAsync = promisify(execFile);

export type TranscodeQualityLevel = "high" | "medium" | "low";

type TranscodeQualityOptions = {
  // VBR rate control. Jasper Lake VDEnc REJECTS ICQ mode (-global_quality →
  // MFX_ERR_INVALID_VIDEO_PARAM -15) and Debian's ffmpeg 5.1 h264_qsv has no
  // -cqp/-qp_i options, so bitrate-targeted VBR is the portable hardware
  // quality control here (verified on-device; see documents/qsv-requirement.md).
  // libx264 mirrors the exact same rate targets for consistent tiering.
  avgBitrate: string;
  maxBitrate: string;
  bufferSize: string;
  // Preset: encoder speed/efficiency tradeoff (QSV VDEnc presets + x264 presets).
  preset: string;
  // Scale factor applied to the source resolution; null keeps the source size.
  scale: number | null;
  // Encoder look-ahead buffer depth for QSV (lower = snappier on weak iGPUs).
  qsvAsyncDepth: number;
};

type ResolvedTranscodeOptions = {
  qualityLevel: TranscodeQualityLevel;
  quality: TranscodeQualityOptions;
  autoEnabled: boolean;
};

class TranscodeError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "TranscodeError";
  }
}

const defaultQualityLevel: TranscodeQualityLevel = "medium";

// Rate-control presets tuned for playback over constrained uplinks (bitrate
// targets sized for the tier caps; VDEnc ICQ is NOT available on Jasper Lake):
// - high: source resolution, 6M avg — home LAN / strong WiFi
// - medium: capped at 720p, 2.5M avg (~310 KB/s) — decent WiFi, fits 500KB/s uplinks
// - low: capped at 480p, 1M avg (~125 KB/s) — weakest hotel/cellular uplinks.
const transcodeQualityLevels: Record<TranscodeQualityLevel, TranscodeQualityOptions> = {
  high: { avgBitrate: "6M", maxBitrate: "8M", bufferSize: "12M", preset: "veryslow", scale: null, qsvAsyncDepth: 4 },
  medium: { avgBitrate: "2500k", maxBitrate: "3500k", bufferSize: "6000k", preset: "veryfast", scale: -2, qsvAsyncDepth: 4 },
  low: { avgBitrate: "1000k", maxBitrate: "1400k", bufferSize: "2400k", preset: "veryfast", scale: -4, qsvAsyncDepth: 2 }
};

function normalizeError(error: unknown): TranscodeError {
  if (error instanceof TranscodeError) {
    return error;
  }

  const errorCode =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim()
      : "";
  const message = stderr || (error instanceof Error ? error.message : "ffmpeg transcode failed.");

  if (errorCode === "ENOENT" || /No such file or directory/i.test(message)) {
    return new TranscodeError(message, false);
  }

  return new TranscodeError(message, true);
}

// QSV init/encode failures that a retry cannot fix: they need configuration changes
// (GPU device passthrough, driver, or TRANSCODE_CODEC=libx264). We deliberately do NOT
// fall back to software encoding silently — software x264 can saturate weak NAS CPUs.
function isQsvConfigurationError(message: string): boolean {
  return /MFX err|init_hw_device|Device creation|failed to initialize|Invalid argument|No such file or directory.*renderD|Cannot allocate memory/i.test(
    message
  );
}

function formatScaleFilter(scale: number | null): string | null {
  // Negative ffmpeg scale values keep the aspect ratio and only downscale.
  return scale === null ? null : `scale=${scale}:-2`;
}

function buildQsvArgs(sourcePath: string, outputPath: string, quality: TranscodeQualityOptions): string[] {
  // low_power=1 forces the VDEnc (EncSliceLP) path required by Jasper Lake and other
  // low-power Intel iGPUs that expose no fixed-function EncSlice entrypoint.
  const videoFilterChain = ["format=nv12", "hwupload=extra_hw_frames=64"];
  const scaleFilter = formatScaleFilter(quality.scale);

  if (scaleFilter) {
    // CPU-side scale stays cheap and VDEnc accepts scaled frames via hwupload.
    videoFilterChain.unshift(scaleFilter);
  }

  return [
    "-v",
    "error",
    "-y",
    "-init_hw_device",
    `qsv=hw:low_power=1`,
    "-filter_hw_device",
    "hw",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    videoFilterChain.join(","),
    "-c:v",
    "h264_qsv",
    "-preset",
    quality.preset,
    "-b:v",
    quality.avgBitrate,
    "-maxrate",
    quality.maxBitrate,
    "-bufsize",
    quality.bufferSize,
    "-async_depth",
    String(quality.qsvAsyncDepth),
    "-c:a",
    "aac",
    "-f",
    "mp4",
    "-movflags",
    "+faststart",
    outputPath
  ];
}

function buildLibx264Args(sourcePath: string, outputPath: string, quality: TranscodeQualityOptions): string[] {
  const scaleFilter = formatScaleFilter(quality.scale);

  return [
    "-v",
    "error",
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    ...(scaleFilter ? ["-vf", scaleFilter] : []),
    "-c:v",
    "libx264",
    "-preset",
    quality.preset,
    "-b:v",
    quality.avgBitrate,
    "-maxrate",
    quality.maxBitrate,
    "-bufsize",
    quality.bufferSize,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-f",
    "mp4",
    "-movflags",
    "+faststart",
    outputPath
  ];
}

class TranscodeService {
  getPlaybackPath(videoId: string): string {
    return `${uploadStoreService.getTranscodesDirectory()}/${videoId}.mp4`;
  }

  // Runtime transcode policy (auto switch + quality level) lives in the preferences
  // store, so the API/UI can flip it without a container restart.
  resolveRuntimeOptions(): ResolvedTranscodeOptions {
    const preferences = preferencesService.getPreferences();
    const qualityLevel = preferences.transcodeQuality;

    return {
      qualityLevel,
      quality: transcodeQualityLevels[qualityLevel] ?? transcodeQualityLevels[defaultQualityLevel],
      autoEnabled: preferences.transcodeAutoEnabled
    };
  }

  async transcodeVideo(videoId: string, sourcePath: string, qualityLevel?: TranscodeQualityLevel): Promise<string> {
    const finalPlaybackPath = this.getPlaybackPath(videoId);
    const tempPlaybackPath = `${finalPlaybackPath}.${randomUUID()}.tmp.mp4`;

    await unlink(tempPlaybackPath).catch(() => undefined);

    const codec = env.transcodeCodec;
    const resolvedQuality = qualityLevel ?? this.resolveRuntimeOptions().qualityLevel;
    const quality = transcodeQualityLevels[resolvedQuality] ?? transcodeQualityLevels[defaultQualityLevel];
    const args =
      codec === "qsv"
        ? buildQsvArgs(sourcePath, tempPlaybackPath, quality)
        : buildLibx264Args(sourcePath, tempPlaybackPath, quality);

    try {
      await execFileAsync("ffmpeg", args, { maxBuffer: 8 * 1024 * 1024 });

      await rename(tempPlaybackPath, finalPlaybackPath);

      return finalPlaybackPath;
    } catch (error) {
      await unlink(tempPlaybackPath).catch(() => undefined);
      const normalized = normalizeError(error);

      if (codec === "qsv" && isQsvConfigurationError(normalized.message)) {
        throw new TranscodeError(
          `QSV transcode failed (hardware encoder unavailable or misconfigured): ${normalized.message}. ` +
            "Check that the DRI device is passed through to the container " +
            `(--device ${env.qsvDevice}) and VA drivers are installed. ` +
            "Hardware encoding is enforced by policy; set TRANSCODE_CODEC=libx264 only if you accept software encoding.",
          false
        );
      }

      throw normalized;
    }
  }
}

export const transcodeService = new TranscodeService();

export { TranscodeError, transcodeQualityLevels };
export type { TranscodeQualityOptions, ResolvedTranscodeOptions };
