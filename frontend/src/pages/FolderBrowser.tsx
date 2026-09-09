import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { apiRequest } from "../api/client";
import { UploadPanel } from "../components/UploadPanel";

type Folder = {
  autoScan: boolean;
  id: string;
  isActive: boolean;
  isSystem: boolean;
  lastScannedAt: number | null;
  maxDepth: number | null;
  mountPath: string;
  name: string;
  scanIntervalMinutes: number | null;
  scanStatus: string;
  videoCount: number;
};

type ScanResult = {
  id: string;
  lastScannedAt: number | null;
  mountPath: string;
  name: string;
  scanStatus: string;
  videoCount: number;
};

const emptyForm = {
  mountPath: "",
  name: ""
};

function translateScanStatus(status: string): string {
  switch (status) {
    case "idle":
      return "待扫描";
    case "scanning":
      return "扫描中";
    case "ready":
      return "扫描完成";
    case "failed":
      return "扫描失败";
    default:
      return status;
  }
}

export function FolderBrowserPage() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadFolders() {
      setIsLoading(true);

      try {
        const result = await apiRequest<Folder[]>("/folders");

        if (!cancelled) {
          setFolders(result);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "加载挂载目录失败。");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadFolders();

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (!folders.some((folder) => folder.scanStatus === "scanning")) {
      return;
    }

    const intervalHandle = window.setInterval(() => {
      setReloadKey((current) => current + 1);
    }, 2500);

    return () => {
      window.clearInterval(intervalHandle);
    };
  }, [folders]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const mountedFolder = await apiRequest<Folder>("/folders", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          mountPath: form.mountPath
        })
      });

      setFeedback(
        mountedFolder.scanStatus === "scanning"
          ? `已挂载 ${mountedFolder.name}，后台扫描已开始。`
          : `已挂载 ${mountedFolder.name}，发现 ${mountedFolder.videoCount} 个视频。`
      );
      setForm(emptyForm);
      setReloadKey((current) => current + 1);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "挂载目录失败。");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleScan(folderId: string) {
    setActiveFolderId(folderId);
    setError(null);

    try {
      const scanResult = await apiRequest<ScanResult>(`/folders/${folderId}/scan`, {
        method: "POST"
      });

      setFeedback(
        scanResult.scanStatus === "scanning"
          ? `已开始扫描 ${scanResult.name}，大目录可能需要一些时间。`
          : `扫描完成 ${scanResult.name}：${scanResult.videoCount} 个视频就绪。`
      );
      setReloadKey((current) => current + 1);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "扫描文件夹失败。");
    } finally {
      setActiveFolderId(null);
    }
  }

  async function handleDelete(folderId: string) {
    setActiveFolderId(folderId);
    setError(null);

    try {
      await apiRequest<{ id: string; removed: boolean }>(`/folders/${folderId}`, {
        method: "DELETE"
      });

      const folderName = folders.find((folder) => folder.id === folderId)?.name ?? "目录";
      setFeedback(`已从挂载来源中移除 ${folderName}。`);
      setReloadKey((current) => current + 1);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "移除文件夹失败。");
    } finally {
      setActiveFolderId(null);
    }
  }

  return (
    <section className="panel-page mounts-page">
      <div className="section-header">
        <div>
          <p className="eyebrow">媒体库</p>
          <h2>挂载目录</h2>
          <p className="sheet-copy">添加路径、扫描入库，然后浏览其中的视频。</p>
        </div>
      </div>

      <form className="mounts-page__composer folder-browser__create" onSubmit={(event) => void handleSubmit(event)}>
        <div className="form-stack folder-browser__form">
          <label className="field">
            名称
            <input
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="旅行短片"
              value={form.name}
            />
          </label>
          <label className="field">
            挂载路径
            <input
              onChange={(event) => setForm((current) => ({ ...current, mountPath: event.target.value }))}
              placeholder="/mounts"
              required
              value={form.mountPath}
            />
          </label>
        </div>
        <div className="folder-browser__actions">
          <p className="plain-note">路径必须位于后端允许的挂载根目录内。</p>
          <button className="action-chip action-chip--primary" disabled={isSubmitting} type="submit">
            {isSubmitting ? "挂载中…" : "添加挂载"}
          </button>
        </div>
      </form>

      <UploadPanel />

      <div className="stack-list">
        {error ? (
          <article className="mounts-page__notice">
            <p>{error}</p>
          </article>
        ) : null}
        {feedback ? (
          <article className="mounts-page__notice">
            <p>{feedback}</p>
          </article>
        ) : null}
        {isLoading ? (
          <article className="mounts-page__notice">
            <p>正在加载挂载目录…</p>
          </article>
        ) : null}
        {!isLoading && folders.length === 0 ? (
          <article className="mounts-page__notice">
            <p>还没有挂载目录。在上方添加一个，信息流就有内容了。</p>
          </article>
        ) : null}
        {folders.map((folder) => (
          <article key={folder.id} className="mounts-page__item">
            <div className="mounts-page__meta">
              <h3>{folder.name}</h3>
              <p className="list-card__path">{folder.mountPath}</p>
              <p className="list-card__path">
                {folder.isSystem ? "系统来源 · " : ""}
                {translateScanStatus(folder.scanStatus)} · {folder.videoCount} 个视频
                {folder.lastScannedAt ? ` · 上次扫描 ${new Date(folder.lastScannedAt * 1000).toLocaleString()}` : ""}
              </p>
            </div>
            <div className="folder-browser__actions">
              <Link className="action-chip action-chip--primary" to={`/folders/${folder.id}`}>
                打开视频
              </Link>
              <button
                className="action-chip"
                disabled={activeFolderId === folder.id || folder.scanStatus === "scanning"}
                onClick={() => void handleScan(folder.id)}
                type="button"
              >
                {activeFolderId === folder.id || folder.scanStatus === "scanning" ? "扫描中…" : "立即扫描"}
              </button>
              {!folder.isSystem ? (
                <button
                  className="action-chip"
                  disabled={activeFolderId === folder.id || folder.scanStatus === "scanning"}
                  onClick={() => void handleDelete(folder.id)}
                  type="button"
                >
                  移除
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
