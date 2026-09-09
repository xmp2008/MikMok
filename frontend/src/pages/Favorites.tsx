import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiRequest } from "../api/client";
import { useUiStore } from "../store/uiStore";

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

type FavoriteVideo = {
  durationSeconds: number | null;
  folderName: string;
  height: number | null;
  id: string;
  mimeType: string;
  playbackStatus: string;
  sourceName: string;
  sourceSize: number;
  thumbnailSmUrl: string | null;
  title: string;
  updatedAt: number;
  width: number | null;
};

export function FavoritesPage() {
  const navigate = useNavigate();
  const favoriteIds = useUiStore((state) => state.favoriteIds);
  const toggleFavoriteId = useUiStore((state) => state.toggleFavoriteId);
  const [videos, setVideos] = useState<FavoriteVideo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadVideos() {
      setIsLoading(true);

      try {
        const result = await apiRequest<FavoriteVideo[]>("/videos/feed");

        if (!cancelled) {
          setVideos(result);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "加载收藏失败。");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadVideos();

    return () => {
      cancelled = true;
    };
  }, []);

  const favoriteVideos = useMemo(() => {
    const videoMap = new Map(videos.map((video) => [video.id, video] as const));
    return favoriteIds.map((favoriteId) => videoMap.get(favoriteId)).filter((video): video is FavoriteVideo => Boolean(video));
  }, [favoriteIds, videos]);

  return (
    <section className="panel-page">
      <div className="section-header">
        <div>
          <p className="eyebrow">收藏</p>
          <h2>收藏</h2>
          <p className="sheet-copy">已收藏的视频。</p>
        </div>
        <span className="pill">{favoriteVideos.length} 个</span>
      </div>

      <div className="stack-list">
        {error ? (
          <article className="list-card">
            <p>{error}</p>
          </article>
        ) : null}

        {isLoading ? (
          <article className="list-card">
            <p>正在加载收藏…</p>
          </article>
        ) : null}

        {!isLoading && favoriteVideos.length === 0 ? (
          <article className="list-card">
            <div>
              <h3>还没有收藏</h3>
              <p className="list-card__path">在信息流里点小心心，视频就会出现在这里。</p>
            </div>
          </article>
        ) : null}

        {favoriteVideos.map((video) => (
          <article key={video.id} className="list-card folder-video-card">
            {video.thumbnailSmUrl ? (
              <img alt={video.title} className="folder-video-page__thumb" loading="lazy" src={video.thumbnailSmUrl} />
            ) : null}
            <div className="folder-video-card__body">
              <h3>{video.title}</h3>
              <p className="list-card__path">{video.sourceName}</p>
              <p className="list-card__path">
                #{video.folderName} · {video.mimeType} · {Math.round(video.sourceSize / 1024 / 1024)} MB
              </p>
              <p className="list-card__path">
                {video.durationSeconds ? `${Math.round(video.durationSeconds)} 秒` : "时长未知"}
                {video.width && video.height ? ` · ${video.width}×${video.height}` : ""}
              </p>
            </div>
            <div className="folder-video-page__meta">
              <span className="pill">{translatePlaybackStatus(video.playbackStatus)}</span>
              <button
                className="action-chip"
                onClick={() => {
                  toggleFavoriteId(video.id);
                }}
                type="button"
              >
                取消收藏
              </button>
              <button
                className="action-chip action-chip--primary"
                onClick={() => {
                  navigate(`/feed?video=${encodeURIComponent(video.id)}`);
                }}
                type="button"
              >
                播放
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
