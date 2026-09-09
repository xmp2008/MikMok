import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink, rename } from "node:fs/promises";
import { promisify } from "node:util";

import { env } from "../../config/env.js";
import { uploadStoreService } from "../storage/uploadStore.js";

const execFileAsync = promisify(execFile);

class TranscodeError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "TranscodeError";
  }
}

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

function buildQsvArgs(sourcePath: string, outputPath: string): string[] {
  // low_power=1 forces the VDEnc (EncSliceLP) path required by Jasper Lake and other
  // low-power Intel iGPUs that expose no fixed-function EncSlice entrypoint.
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
    "format=nv12,hwupload=extra_hw_frames=64",
    "-c:v",
    "h264_qsv",
    "-preset",
    "veryfast",
    "-global_quality",
    "23",
    "-c:a",
    "aac",
    "-f",
    "mp4",
    "-movflags",
    "+faststart",
    outputPath
  ];
}

function buildLibx264Args(sourcePath: string, outputPath: string): string[] {
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
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
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

  async transcodeVideo(videoId: string, sourcePath: string): Promise<string> {
    const finalPlaybackPath = this.getPlaybackPath(videoId);
    const tempPlaybackPath = `${finalPlaybackPath}.${randomUUID()}.tmp.mp4`;

    await unlink(tempPlaybackPath).catch(() => undefined);

    const codec = env.transcodeCodec;
    const args = codec === "qsv" ? buildQsvArgs(sourcePath, tempPlaybackPath) : buildLibx264Args(sourcePath, tempPlaybackPath);

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

export { TranscodeError };
