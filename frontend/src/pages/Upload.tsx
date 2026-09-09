import { FormEvent, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { apiRequest } from "../api/client";

const acceptedFormats = ["mp4", "mov", "mkv", "avi", "webm", "m4v", "3gp", "flv", "wmv", "ts"];

type UploadedVideo = {
  id: string;
  sourceName: string;
  streamUrl: string;
  title: string;
};

type UploadResponse = {
  accepted: number;
  folderId: string;
  folderName: string;
  rejected: string[];
  uploadBatchId: string;
  videos: UploadedVideo[];
};

export function UploadPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const acceptValue = useMemo(() => acceptedFormats.map((format) => `.${format}`).join(","), []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (selectedFiles.length === 0) {
      setError("请至少选择一个视频文件。");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const formData = new FormData();

      for (const file of selectedFiles) {
        formData.append("files[]", file);
      }

      const uploadResult = await apiRequest<UploadResponse>("/uploads", {
        method: "POST",
        body: formData
      });

      setResult(uploadResult);
      setSelectedFiles([]);

      if (inputRef.current) {
        inputRef.current.value = "";
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "上传失败。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="panel-page">
      <div className="section-header">
        <div>
          <p className="eyebrow">上传</p>
          <h2>把视频放进信息流正在使用的同一个媒体库。</h2>
          <p className="sheet-copy">上传的文件会进入系统管理的 Uploads 来源，并立即重新索引进信息流。</p>
        </div>
        <span className="pill">第 3 步</span>
      </div>

      <form className="feature-card form-stack" onSubmit={(event) => void handleSubmit(event)}>
        <label className="field">
          视频文件
          <input
            accept={acceptValue}
            multiple
            onChange={(event) => setSelectedFiles(Array.from(event.target.files ?? []))}
            ref={inputRef}
            type="file"
          />
        </label>

        <div className="tag-row">
          {acceptedFormats.map((format) => (
            <span key={format} className="pill">
              .{format}
            </span>
          ))}
        </div>

        <div className="upload-page__summary">
          <p className="sheet-copy">
            {selectedFiles.length > 0 ? `${selectedFiles.length} 个文件待上传。` : "选择一个或多个支持的视频文件。"}
          </p>
          <button className="action-chip action-chip--primary" disabled={isSubmitting || selectedFiles.length === 0} type="submit">
            {isSubmitting ? "上传中…" : "上传视频"}
          </button>
        </div>

        {selectedFiles.length > 0 ? (
          <div className="stack-list">
            {selectedFiles.map((file) => (
              <article key={`${file.name}-${file.size}-${file.lastModified}`} className="list-card">
                <div>
                  <h3>{file.name}</h3>
                  <p className="list-card__path">{Math.max(1, Math.round(file.size / 1024 / 1024))} MB</p>
                </div>
              </article>
            ))}
          </div>
        ) : null}

        {error ? (
          <article className="list-card">
            <p>{error}</p>
          </article>
        ) : null}
      </form>

      {result ? (
        <div className="stack-list">
          <article className="list-card">
            <div>
              <h3>已入库 {result.accepted} 个视频</h3>
              <p className="list-card__path">
                批次 {result.uploadBatchId} · 来源 {result.folderName}
              </p>
              {result.rejected.length > 0 ? <p className="list-card__path">被拒绝：{result.rejected.join(", ")}</p> : null}
            </div>
            <Link className="action-chip action-chip--primary" to={`/folders/${result.folderId}`}>
              打开上传库
            </Link>
          </article>

          {result.videos.map((video) => (
            <article key={video.id} className="list-card">
              <div>
                <h3>{video.title}</h3>
                <p className="list-card__path">{video.sourceName}</p>
              </div>
              <button
                className="action-chip action-chip--primary"
                onClick={() => {
                  navigate(`/feed?video=${encodeURIComponent(video.id)}`);
                }}
                type="button"
              >
                播放
              </button>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
