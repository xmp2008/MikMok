import { Router } from "express";

import { jobWorkerService } from "../services/jobs/jobWorker.js";
import { preferencesService } from "../services/preferences/preferencesService.js";
import { mediaLibraryService } from "../services/library/mediaLibrary.js";
import { isPlayablePlaybackStatus } from "../services/media/playbackPolicy.js";
import { sendSuccess } from "../utils/http.js";
import { AppError } from "../utils/http.js";

export const playbackRouter = Router();

/**
 * POST /api/playback/prepare/:videoId
 *
 * Playback-triggered transcode entry point: when the viewer opens a clip that is
 * not directly playable (needs_transcode / failed / stuck processing), enqueue a
 * transcode job on demand and tell the client to poll. Direct/ready clips are a
 * no-op. Never starts the encoder when auto transcoding is switched off.
 */
playbackRouter.post("/prepare/:videoId", async (request, response) => {
  const video = await mediaLibraryService.findVideoById(request.params.videoId);

  if (!video) {
    throw new AppError(404, "VIDEO_NOT_FOUND", "Video not found.");
  }

  if (isPlayablePlaybackStatus(video.playbackStatus)) {
    sendSuccess(response, {
      playbackStatus: video.playbackStatus,
      streamUrl: `/stream/${video.id}`,
      transcoding: false
    });
    return;
  }

  if (!preferencesService.getPreferences().transcodeAutoEnabled) {
    throw new AppError(409, "TRANSCODE_DISABLED", "自动转码已关闭，无法准备该视频（可在设置中开启）。");
  }

  const job = await jobWorkerService.enqueueTranscodes([video.id]);

  if (!job) {
    // enqueueTranscodes returns null only when the switch flipped between checks
    // or the video vanished; surface it as a plain conflict for the client.
    throw new AppError(409, "TRANSCODE_NOT_QUEUED", "视频当前无法加入转码队列。");
  }

  sendSuccess(response, {
    jobId: job.id,
    playbackStatus: "processing",
    progress: {
      current: job.progressCurrent,
      message: job.progressMessage,
      total: job.progressTotal
    },
    statusUrl: `/api/playback/status/${video.id}`,
    streamUrl: `/stream/${video.id}`,
    transcoding: true
  });
});

/**
 * GET /api/playback/status/:videoId
 *
 * Polling endpoint used by the player overlay while a playback-triggered
 * transcode runs. Reports the video playback status plus live job progress.
 */
playbackRouter.get("/status/:videoId", async (request, response) => {
  const video = await mediaLibraryService.findVideoById(request.params.videoId);

  if (!video) {
    throw new AppError(404, "VIDEO_NOT_FOUND", "Video not found.");
  }

  const job = jobWorkerService.findActiveTranscodeJob(video.id);

  sendSuccess(response, {
    jobId: job?.id ?? null,
    playbackStatus: video.playbackStatus,
    progress: job
      ? {
          attemptCount: job.attemptCount,
          current: job.progressCurrent,
          lastError: job.lastError,
          message: job.progressMessage,
          status: job.status,
          total: job.progressTotal
        }
      : null,
    streamUrl: `/stream/${video.id}`,
    transcoding: video.playbackStatus === "processing"
  });
});
