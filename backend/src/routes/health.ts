import { Router } from "express";

import { env } from "../config/env.js";
import { dbConfig } from "../db/index.js";
import { jobService } from "../services/jobs/jobService.js";
import { metadataExtractor } from "../services/media/metadataExtractor.js";
import { thumbnailService } from "../services/media/thumbnailService.js";
import { preferencesService } from "../services/preferences/preferencesService.js";
import { sendSuccess } from "../utils/http.js";

export const healthRouter = Router();

healthRouter.get("/", async (_request, response) => {
  const [ffmpegAvailable, ffprobeAvailable] = await Promise.all([
    thumbnailService.isAvailable(),
    metadataExtractor.isAvailable()
  ]);
  const preferences = preferencesService.getPreferences();

  sendSuccess(response, {
    service: "mikmok-api",
    status: "ok",
    environment: env.NODE_ENV,
    timestamp: Math.floor(Date.now() / 1000),
    transcodeEnabled: env.transcodeEnabled,
    transcodeAutoEnabled: preferences.transcodeAutoEnabled,
    transcodeQuality: preferences.transcodeQuality,
    transcodeCodec: env.transcodeCodec,
    ffmpegAvailable,
    ffprobeAvailable,
    jobs: jobService.getJobCounts(),
    dbFile: dbConfig.filename
  });
});
