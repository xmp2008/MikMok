import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

type FolderVideo = {
  durationSeconds: number | null;
  folderId: string;
  folderName: string;
  height: number | null;
  id: string;
  mimeType: string;
  playCount: number;
  playbackStatus: string;
  resumePositionSeconds: number;
  sourceName: string;
  sourceSize: number;
  streamUrl: string;
  thumbnailSmUrl: string | null;
  title: string;
  updatedAt: number;
  width: number | null;
};

type FolderVideosResponseMeta = {
  folderName: string;
  total: number;
};

function translatePlaybackStatus(status: string): string {
  switch (status) {
    case "direct":
      return "可直连播放";
    case "ready":
      return "转码就绪";
    case "processing":
      return "转码中";
    case "needs_transcode":
      return "需要转码";
    case "failed":
      return "转码失败";
    default:
      return status;
  }
}

export function FolderVideosPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [videos, setVideos] = useState<FolderVideo[]>([]);
  const [meta, setMeta] = useState<FolderVideosResponseMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setError("缺少文件夹 ID。");
      return;
    }

    let cancelled = false;

    async function loadFolderVideos() {
      try {
        const response = await fetch(`/api/folders/${id}/videos`, {
          credentials: "include"
        });
        const payload = (await response.json()) as {
          data: FolderVideo[];
          meta?: FolderVideosResponseMeta;
          success: boolean;
        };

        if (!response.ok || !payload.success) {
          throw new Error("加载文件夹视频失败。");
        }

        if (!cancelled) {
          setVideos(payload.data);
          setMeta(payload.meta ?? null);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "加载文件夹视频失败。");
        }
      }
    }

    void loadFolderVideos();

    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <section className="panel-page folder-videos-page">
      <div className="section-header">
        <div>
          <p className="eyebrow">文件夹</p>
          <h2>{meta?.folderName ?? "正在加载…"}</h2>
          <p className="sheet-copy">此挂载目录中的视频。</p>
        </div>
        <Link className="action-chip" to="/folders">
          返回
        </Link>
      </div>

      <div className="stack-list">
        {error ? <article className="list-card"><p>{error}</p></article> : null}
        {videos.map((video) => (
          <article key={video.id} className="list-card folder-video-card">
            {video.thumbnailSmUrl ? (
              <img alt={video.title} className="folder-video-page__thumb" loading="lazy" src={video.thumbnailSmUrl} />
            ) : null}
            <div className="folder-video-card__body">
              <h3>{video.title}</h3>
              <p className="list-card__path">{video.sourceName}</p>
              <p className="list-card__path">
                {video.mimeType} · {translatePlaybackStatus(video.playbackStatus)} · {Math.round(video.sourceSize / 1024 / 1024)} MB · 更新于{" "}
                {new Date(video.updatedAt * 1000).toLocaleString()}
              </p>
              <p className="list-card__path">
                {video.durationSeconds ? `${Math.round(video.durationSeconds)} 秒` : "时长未知"}
                {video.width && video.height ? ` · ${video.width}×${video.height}` : ""}
              </p>
            </div>
            <div className="folder-video-page__meta">
              <span className="pill">播放 {video.playCount} 次</span>
              <span className="pill">续播 {Math.round(video.resumePositionSeconds)} 秒</span>
              <button
                className="action-chip action-chip--primary"
                onClick={() => {
                  navigate(`/feed?video=${encodeURIComponent(video.id)}`);
                }}
                type="button"
              >
                {video.playbackStatus === "direct" || video.playbackStatus === "ready" ? "播放" : "播放（先转码）"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
