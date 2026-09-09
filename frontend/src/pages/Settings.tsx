import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { apiRequest } from "../api/client";
import { useAuth } from "../hooks/useAuth";
import { type PlaybackCompletionMode, type TranscodeQualityLevel, useUiStore } from "../store/uiStore";

type HealthData = {
  dbFile: string;
  environment: string;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  jobs: {
    failed: number;
    queued: number;
    running: number;
    succeeded: number;
    total: number;
  };
  service: string;
  status: string;
  timestamp: number;
  transcodeEnabled: boolean;
  transcodeAutoEnabled?: boolean;
  transcodeQuality?: TranscodeQualityLevel;
  transcodeCodec?: string;
};

type JobSnapshot = {
  attemptCount: number;
  createdAt: number;
  finishedAt: number | null;
  id: string;
  lastError: string | null;
  progressCurrent: number;
  progressMessage: string | null;
  progressTotal: number;
  relatedEntityId: string | null;
  relatedEntityType: string | null;
  startedAt: number | null;
  status: string;
  type: string;
  updatedAt: number;
};

type RemoteSourceAuthMode = "integration_api_key" | "none" | "session_cookie";
type RemoteSourceScopeMode = "all" | "authors" | "collections" | "mixed";

type RemoteSource = {
  authMode: RemoteSourceAuthMode;
  authorKeys: string[];
  baseUrl: string;
  collectionIds: string[];
  enabled: boolean;
  hasCredential: boolean;
  id: string;
  lastValidatedAt: number | null;
  name: string;
  scopeMode: RemoteSourceScopeMode;
};

type RemoteSourceDiscovery = {
  authors: Array<{
    avatarUrl: string | null;
    key: string;
    name: string;
    videoCount: number;
  }>;
  collections: Array<{
    id: string;
    name: string;
    videoCount: number;
  }>;
  videoCount: number;
};

type RemoteSourceForm = {
  authMode: RemoteSourceAuthMode;
  authorKeys: string[];
  baseUrl: string;
  collectionIds: string[];
  credential: string;
  enabled: boolean;
  name: string;
  scopeMode: RemoteSourceScopeMode;
};

const playbackCompletionOptions: Array<{ label: string; value: PlaybackCompletionMode }> = [
  { label: "停止播放", value: "stop" },
  { label: "播放下一个", value: "next" },
  { label: "单曲循环", value: "repeat" }
];

const transcodeQualityOptions: Array<{ label: string; value: TranscodeQualityLevel }> = [
  { label: "高 · 原画质 6M", value: "high" },
  { label: "中 · 720p 2.5M", value: "medium" },
  { label: "低 · 480p 1M", value: "low" }
];

const authModeOptions: Array<{ label: string; value: RemoteSourceAuthMode }> = [
  { label: "无认证", value: "none" },
  { label: "会话 Cookie", value: "session_cookie" },
  { label: "集成 API 密钥", value: "integration_api_key" }
];

const scopeModeOptions: Array<{ label: string; value: RemoteSourceScopeMode }> = [
  { label: "全部内容", value: "all" },
  { label: "选中的合集", value: "collections" },
  { label: "选中的作者", value: "authors" },
  { label: "合集 + 作者", value: "mixed" }
];

const emptyRemoteSourceForm: RemoteSourceForm = {
  enabled: true,
  name: "",
  baseUrl: "",
  authMode: "none",
  credential: "",
  scopeMode: "all",
  collectionIds: [],
  authorKeys: []
};

const newRemoteSourceSelectionId = "__new__";

function translateJobStatus(status: string): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "进行中";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return status;
  }
}

function translateJobProgress(message: string | null): string {
  switch (message) {
    case "Queued for transcode.":
      return "已加入转码队列。";
    case "Queued for retry.":
      return "已加入重试队列。";
    case "Preparing transcode.":
      return "正在准备转码。";
    case "Running ffmpeg.":
      return "正在转码（QSV 硬编）。";
    case "Publishing playback artifact.":
      return "正在发布播放文件。";
    case "Playback ready.":
      return "可以播放了。";
    case "Job failed.":
      return "任务失败。";
    case "Direct playback is available.":
      return "该视频可直连播放，无需转码。";
    case "Transcoded playback is already ready.":
      return "转码产物已就绪。";
    default:
      return message ?? "暂无进度信息。";
  }
}

function createRemoteSourceForm(source?: RemoteSource | null): RemoteSourceForm {
  if (!source) {
    return emptyRemoteSourceForm;
  }

  return {
    enabled: source.enabled,
    name: source.name,
    baseUrl: source.baseUrl,
    authMode: source.authMode,
    credential: "",
    scopeMode: source.scopeMode,
    collectionIds: source.collectionIds,
    authorKeys: source.authorKeys
  };
}

export function SettingsPage() {
  const { authEnabled, authenticated, logout, sessionExpiresAt } = useAuth();
  const playbackCompletionMode = useUiStore((state) => state.playbackCompletionMode);
  const setPlaybackCompletionMode = useUiStore((state) => state.setPlaybackCompletionMode);
  const setSoundOnOpen = useUiStore((state) => state.setSoundOnOpen);
  const soundOnOpen = useUiStore((state) => state.soundOnOpen);
  const transcodeAutoEnabled = useUiStore((state) => state.transcodeAutoEnabled);
  const setTranscodeAutoEnabled = useUiStore((state) => state.setTranscodeAutoEnabled);
  const transcodeQuality = useUiStore((state) => state.transcodeQuality);
  const setTranscodeQuality = useUiStore((state) => state.setTranscodeQuality);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [remoteSources, setRemoteSources] = useState<RemoteSource[]>([]);
  const [selectedRemoteSourceId, setSelectedRemoteSourceId] = useState<string | null>(null);
  const [remoteSourceForm, setRemoteSourceForm] = useState<RemoteSourceForm>(emptyRemoteSourceForm);
  const [remoteSourceError, setRemoteSourceError] = useState<string | null>(null);
  const [remoteSourceFeedback, setRemoteSourceFeedback] = useState<string | null>(null);
  const [remoteDiscovery, setRemoteDiscovery] = useState<RemoteSourceDiscovery | null>(null);
  const [isLoadingRemoteSources, setIsLoadingRemoteSources] = useState(false);
  const [isSavingRemoteSource, setIsSavingRemoteSource] = useState(false);
  const [isTestingRemoteSource, setIsTestingRemoteSource] = useState(false);
  const [isDiscoveringRemoteSource, setIsDiscoveringRemoteSource] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadHealth() {
      try {
        const result = await apiRequest<HealthData>("/health");

        if (!cancelled) {
          setHealth(result);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "加载服务状态失败。");
        }
      }
    }

    void loadHealth();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadJobs() {
      try {
        const result = await apiRequest<JobSnapshot[]>("/jobs?limit=8");

        if (!cancelled) {
          setJobs(result);
        }
      } catch (loadError) {
        if (!cancelled) {
          setJobsError(loadError instanceof Error ? loadError.message : "加载任务列表失败。");
        }
      }
    }

    void loadJobs();
    const intervalHandle = window.setInterval(() => {
      void loadJobs();
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalHandle);
    };
  }, []);

  useEffect(() => {
    if (!authenticated) {
      setRemoteSources([]);
      setSelectedRemoteSourceId(null);
      setRemoteSourceForm(emptyRemoteSourceForm);
      setRemoteDiscovery(null);
      return;
    }

    let cancelled = false;

    async function loadRemoteSources() {
      setIsLoadingRemoteSources(true);

      try {
        const result = await apiRequest<RemoteSource[]>("/remote-sources");

        if (!cancelled) {
          setRemoteSources(result);
          setRemoteSourceError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setRemoteSourceError(loadError instanceof Error ? loadError.message : "加载远程来源失败。");
        }
      } finally {
        if (!cancelled) {
          setIsLoadingRemoteSources(false);
        }
      }
    }

    void loadRemoteSources();

    return () => {
      cancelled = true;
    };
  }, [authenticated]);

  const selectedRemoteSource = useMemo(
    () =>
      selectedRemoteSourceId === newRemoteSourceSelectionId
        ? null
        : remoteSources.find((source) => source.id === selectedRemoteSourceId) ?? null,
    [remoteSources, selectedRemoteSourceId]
  );

  useEffect(() => {
    if (selectedRemoteSourceId === newRemoteSourceSelectionId) {
      setRemoteSourceForm(emptyRemoteSourceForm);
      return;
    }

    if (!selectedRemoteSourceId) {
      if (remoteSources.length > 0) {
        setSelectedRemoteSourceId(remoteSources[0]?.id ?? null);
      }

      return;
    }

    if (!selectedRemoteSource) {
      setSelectedRemoteSourceId(remoteSources[0]?.id ?? null);
      return;
    }

    setRemoteSourceForm(createRemoteSourceForm(selectedRemoteSource));
  }, [remoteSources, selectedRemoteSource, selectedRemoteSourceId]);

  async function reloadRemoteSources(nextSelectedSourceId?: string | null) {
    if (!authenticated) {
      return;
    }

    const result = await apiRequest<RemoteSource[]>("/remote-sources");
    setRemoteSources(result);

    if (nextSelectedSourceId !== undefined) {
      setSelectedRemoteSourceId(nextSelectedSourceId);
      return;
    }

    if (selectedRemoteSourceId && result.some((source) => source.id === selectedRemoteSourceId)) {
      setSelectedRemoteSourceId(selectedRemoteSourceId);
      return;
    }

    setSelectedRemoteSourceId(result[0]?.id ?? null);
  }

  async function handleSaveRemoteSource() {
    setIsSavingRemoteSource(true);
    setRemoteSourceError(null);

    try {
      const payload = {
        enabled: remoteSourceForm.enabled,
        name: remoteSourceForm.name,
        baseUrl: remoteSourceForm.baseUrl,
        authMode: remoteSourceForm.authMode,
        scopeMode: remoteSourceForm.scopeMode,
        collectionIds: remoteSourceForm.collectionIds,
        authorKeys: remoteSourceForm.authorKeys,
        ...(remoteSourceForm.credential.trim().length > 0 ? { credential: remoteSourceForm.credential.trim() } : {})
      };

      const savedSource = selectedRemoteSource
        ? await apiRequest<RemoteSource>(`/remote-sources/${selectedRemoteSource.id}`, {
            method: "PATCH",
            body: JSON.stringify(payload)
          })
        : await apiRequest<RemoteSource>("/remote-sources", {
            method: "POST",
            body: JSON.stringify({
              ...payload,
              type: "mytube"
            })
          });

      setRemoteSourceFeedback(selectedRemoteSource ? `已更新 ${savedSource.name}。` : `已创建 ${savedSource.name}。`);
      await reloadRemoteSources(savedSource.id);
      setRemoteSourceForm(createRemoteSourceForm(savedSource));
    } catch (saveError) {
      setRemoteSourceError(saveError instanceof Error ? saveError.message : "保存远程来源失败。");
    } finally {
      setIsSavingRemoteSource(false);
    }
  }

  async function handleDeleteRemoteSource() {
    if (!selectedRemoteSource) {
      return;
    }

    setIsSavingRemoteSource(true);
    setRemoteSourceError(null);

    try {
      await apiRequest<{ id: string; removed: boolean }>(`/remote-sources/${selectedRemoteSource.id}`, {
        method: "DELETE"
      });

      setRemoteSourceFeedback(`已删除 ${selectedRemoteSource.name}。`);
      setRemoteDiscovery(null);
      setRemoteSourceForm(emptyRemoteSourceForm);
      await reloadRemoteSources(null);
    } catch (deleteError) {
      setRemoteSourceError(deleteError instanceof Error ? deleteError.message : "删除远程来源失败。");
    } finally {
      setIsSavingRemoteSource(false);
    }
  }

  async function handleTestRemoteSource() {
    if (!selectedRemoteSource) {
      setRemoteSourceError("请先保存来源再测试。");
      return;
    }

    setIsTestingRemoteSource(true);
    setRemoteSourceError(null);

    try {
      const result = await apiRequest<{ collectionCount: number; lastValidatedAt: number | null; videoCount: number }>(
        `/remote-sources/${selectedRemoteSource.id}/test`,
        {
          method: "POST"
        }
      );

      setRemoteSourceFeedback(
        `已连接 ${selectedRemoteSource.name}：${result.videoCount} 个视频、${result.collectionCount} 个合集。`
      );
      await reloadRemoteSources(selectedRemoteSource.id);
    } catch (testError) {
      setRemoteSourceError(testError instanceof Error ? testError.message : "连接测试失败。");
    } finally {
      setIsTestingRemoteSource(false);
    }
  }

  async function handleDiscoverRemoteSource() {
    if (!selectedRemoteSource) {
      setRemoteSourceError("请先保存来源再执行发现。");
      return;
    }

    setIsDiscoveringRemoteSource(true);
    setRemoteSourceError(null);

    try {
      const result = await apiRequest<RemoteSourceDiscovery>(`/remote-sources/${selectedRemoteSource.id}/discover`, {
        method: "POST"
      });

      setRemoteDiscovery(result);
      setRemoteSourceFeedback(`从 ${selectedRemoteSource.name} 发现 ${result.videoCount} 个视频。`);
    } catch (discoverError) {
      setRemoteSourceError(discoverError instanceof Error ? discoverError.message : "发现失败。");
    } finally {
      setIsDiscoveringRemoteSource(false);
    }
  }

  function toggleCollection(collectionId: string) {
    setRemoteSourceForm((current) => ({
      ...current,
      collectionIds: current.collectionIds.includes(collectionId)
        ? current.collectionIds.filter((value) => value !== collectionId)
        : [...current.collectionIds, collectionId]
    }));
  }

  function toggleAuthor(authorKey: string) {
    setRemoteSourceForm((current) => ({
      ...current,
      authorKeys: current.authorKeys.includes(authorKey)
        ? current.authorKeys.filter((value) => value !== authorKey)
        : [...current.authorKeys, authorKey]
    }));
  }

  return (
    <section className="panel-page settings-page">
      <div className="section-header">
        <div>
          <p className="eyebrow">设置</p>
          <h2>设置</h2>
          <p className="sheet-copy">播放偏好与后台转码任务。</p>
        </div>
      </div>

      <article className="list-card settings-card">
        <div>
          <p className="eyebrow">播放</p>
          <h3>默认播放行为</h3>
          <p className="list-card__path">控制信息流打开方式，以及单个视频播放结束后的动作。</p>
        </div>
        <div className="settings-controls">
          <div className="settings-control">
            <div className="settings-control__copy">
              <p className="settings-control__label">打开时出声</p>
              <p className="settings-control__help">
                {soundOnOpen ? "新会话打开信息流时自动开启声音。" : "新会话打开信息流时保持静音。"}
              </p>
            </div>
            <button
              aria-checked={soundOnOpen}
              className={soundOnOpen ? "settings-switch settings-switch--active" : "settings-switch"}
              onClick={() => setSoundOnOpen(!soundOnOpen)}
              role="switch"
              type="button"
            >
              <span className="settings-switch__thumb" />
            </button>
          </div>

          <label className="settings-control settings-control--stacked">
            <div className="settings-control__copy">
              <p className="settings-control__label">播放结束时</p>
              <p className="settings-control__help">选择播放器停止、自动下一个还是循环当前视频。</p>
            </div>
            <span className="settings-select-wrap">
              <select
                className="settings-select"
                onChange={(event) => setPlaybackCompletionMode(event.target.value as PlaybackCompletionMode)}
                value={playbackCompletionMode}
              >
                {playbackCompletionOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="settings-select__icon" aria-hidden="true">
                <svg viewBox="0 0 20 20">
                  <path
                    d="M5.25 7.75 10 12.5l4.75-4.75"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.8"
                  />
                </svg>
              </span>
            </span>
          </label>
        </div>
      </article>

      <article className="list-card settings-card">
        <div>
          <p className="eyebrow">转码</p>
          <h3>自动转码</h3>
          <p className="list-card__path">
            转码让视频播放更流畅。关闭自动转码可让 NAS 保持安静——非 H.264 视频将无法播放，直到重新开启。
            弱 WiFi 环境建议选择更低画质。
          </p>
        </div>
        <div className="settings-controls">
          <div className="settings-control">
            <div className="settings-control__copy">
              <p className="settings-control__label">自动转码</p>
              <p className="settings-control__help">
                {transcodeAutoEnabled
                  ? "播放到需要转码的视频时自动开始转码（QSV 硬编，不吃 CPU）。"
                  : "自动转码已暂停，编码器保持空闲。"}
              </p>
            </div>
            <button
              aria-checked={transcodeAutoEnabled}
              className={transcodeAutoEnabled ? "settings-switch settings-switch--active" : "settings-switch"}
              onClick={() => setTranscodeAutoEnabled(!transcodeAutoEnabled)}
              role="switch"
              type="button"
            >
              <span className="settings-switch__thumb" />
            </button>
          </div>

          <label className="settings-control settings-control--stacked">
            <div className="settings-control__copy">
              <p className="settings-control__label">转码画质</p>
              <p className="settings-control__help">
                {transcodeQuality === "high"
                  ? "原分辨率最佳画质，适合家里宽带环境。"
                  : transcodeQuality === "low"
                    ? "480p 最省流量，适合弱 WiFi 或流量环境。"
                    : "720p 画质与码率均衡，弱 WiFi 也能播。"}
              </p>
            </div>
            <span className="settings-select-wrap">
              <select
                className="settings-select"
                onChange={(event) => setTranscodeQuality(event.target.value as TranscodeQualityLevel)}
                value={transcodeQuality}
              >
                {transcodeQualityOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="settings-select__icon" aria-hidden="true">
                <svg viewBox="0 0 20 20">
                  <path
                    d="M5.25 7.75 10 12.5l4.75-4.75"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.8"
                  />
                </svg>
              </span>
            </span>
          </label>

          {health ? (
            <p className="plain-note">
              编码器：{health.transcodeCodec ?? "未知"}
              {health.transcodeEnabled ? "" : "（已被 TRANSCODE_ENABLED 环境变量禁用）"}
            </p>
          ) : null}
        </div>
      </article>

      <div className="stack-list">
        <article className="list-card">
          <div>
            <p className="eyebrow">访问控制</p>
            <h3>{authEnabled ? (authenticated ? "会话登录已启用" : "远程源需要先登录") : "未启用认证"}</h3>
            <p className="list-card__path">
              {authEnabled
                ? authenticated && sessionExpiresAt
                  ? `登录将于 ${new Date(sessionExpiresAt * 1000).toLocaleString()} 过期`
                  : "远程源凭据仅在管理员登录后才会展示。"
                : "演示模式跳过登录，首页直接进入播放。"}
            </p>
          </div>
          {authEnabled ? (
            authenticated ? (
              <button className="action-chip" onClick={() => void logout()} type="button">
                退出登录
              </button>
            ) : (
              <Link className="action-chip action-chip--primary" to="/login">
                去登录
              </Link>
            )
          ) : (
            <span className="pill pill--solid">已跳过</span>
          )}
        </article>

        <article className="list-card settings-card">
          <div>
            <p className="eyebrow">MyTube 来源</p>
            <h3>远程只读接入</h3>
            <p className="list-card__path">
              配置由后端托管的 MyTube 来源。凭据保存在服务器上，仅通过 MikMok 代理使用。
            </p>
          </div>
          {!authenticated ? (
            <div className="stack-list">
              <p className="plain-note">请先登录，才能创建、测试或发现远程来源。</p>
              <Link className="button" to="/login">
                登录后配置
              </Link>
            </div>
          ) : (
            <div className="settings-remote-source">
              <div className="settings-remote-source__toolbar">
                <div className="tag-row">
                  {remoteSources.map((source) => (
                    <button
                      className={
                        selectedRemoteSourceId === source.id
                          ? "action-chip action-chip--primary"
                          : "action-chip"
                      }
                      key={source.id}
                      onClick={() => {
                        setSelectedRemoteSourceId(source.id);
                        setRemoteDiscovery(null);
                        setRemoteSourceFeedback(null);
                        setRemoteSourceError(null);
                      }}
                      type="button"
                    >
                      {source.name}
                    </button>
                  ))}
                  <button
                    className={selectedRemoteSourceId === newRemoteSourceSelectionId ? "action-chip action-chip--primary" : "action-chip"}
                    onClick={() => {
                      setSelectedRemoteSourceId(newRemoteSourceSelectionId);
                      setRemoteSourceForm(emptyRemoteSourceForm);
                      setRemoteDiscovery(null);
                      setRemoteSourceFeedback(null);
                      setRemoteSourceError(null);
                    }}
                    type="button"
                  >
                    新建来源
                  </button>
                </div>
                {selectedRemoteSource ? (
                  <p className="plain-note">
                    {selectedRemoteSource.hasCredential ? "凭据已保存" : "尚未保存凭据"}
                    {selectedRemoteSource.lastValidatedAt
                      ? ` · 上次验证 ${new Date(selectedRemoteSource.lastValidatedAt * 1000).toLocaleString()}`
                      : ""}
                  </p>
                ) : (
                  <p className="plain-note">先创建来源，再执行测试与发现。</p>
                )}
              </div>

              <div className="form-stack">
                <label className="field">
                  来源名称
                  <input
                    onChange={(event) => setRemoteSourceForm((current) => ({ ...current, name: event.target.value }))}
                    placeholder="Studio MyTube"
                    value={remoteSourceForm.name}
                  />
                </label>

                <label className="field">
                  基础地址
                  <input
                    onChange={(event) => setRemoteSourceForm((current) => ({ ...current, baseUrl: event.target.value }))}
                    placeholder="https://mytube.example.com"
                    value={remoteSourceForm.baseUrl}
                  />
                </label>

                <label className="field">
                  认证方式
                  <select
                    onChange={(event) =>
                      setRemoteSourceForm((current) => ({
                        ...current,
                        authMode: event.target.value as RemoteSourceAuthMode
                      }))
                    }
                    value={remoteSourceForm.authMode}
                  >
                    {authModeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                {remoteSourceForm.authMode !== "none" ? (
                  <label className="field">
                    凭据
                    <textarea
                      onChange={(event) =>
                        setRemoteSourceForm((current) => ({
                          ...current,
                          credential: event.target.value
                        }))
                      }
                      placeholder={
                        selectedRemoteSource?.hasCredential
                          ? "留空则保留已保存的凭据"
                          : remoteSourceForm.authMode === "session_cookie"
                            ? "粘贴 MyTube 会话 Cookie"
                            : "粘贴 MyTube 集成 API 密钥"
                      }
                      rows={3}
                      value={remoteSourceForm.credential}
                    />
                  </label>
                ) : null}

                <label className="field">
                  范围
                  <select
                    onChange={(event) =>
                      setRemoteSourceForm((current) => ({
                        ...current,
                        scopeMode: event.target.value as RemoteSourceScopeMode
                      }))
                    }
                    value={remoteSourceForm.scopeMode}
                  >
                    {scopeModeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="settings-control">
                  <div className="settings-control__copy">
                    <p className="settings-control__label">启用</p>
                    <p className="settings-control__help">停用的来源保留配置，但不再产生信息流内容。</p>
                  </div>
                  <button
                    aria-checked={remoteSourceForm.enabled}
                    className={remoteSourceForm.enabled ? "settings-switch settings-switch--active" : "settings-switch"}
                    onClick={() =>
                      setRemoteSourceForm((current) => ({
                        ...current,
                        enabled: !current.enabled
                      }))
                    }
                    role="switch"
                    type="button"
                  >
                    <span className="settings-switch__thumb" />
                  </button>
                </div>

                {remoteDiscovery && (remoteSourceForm.scopeMode === "collections" || remoteSourceForm.scopeMode === "mixed") ? (
                  <div className="settings-remote-source__picker">
                    <p className="settings-control__label">合集</p>
                    <div className="settings-remote-source__options">
                      {remoteDiscovery.collections.map((collection) => (
                        <button
                          className={
                            remoteSourceForm.collectionIds.includes(collection.id)
                              ? "action-chip action-chip--primary"
                              : "action-chip"
                          }
                          key={collection.id}
                          onClick={() => toggleCollection(collection.id)}
                          type="button"
                        >
                          {collection.name} · {collection.videoCount}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {remoteDiscovery && (remoteSourceForm.scopeMode === "authors" || remoteSourceForm.scopeMode === "mixed") ? (
                  <div className="settings-remote-source__picker">
                    <p className="settings-control__label">作者</p>
                    <div className="settings-remote-source__options settings-remote-source__options--authors">
                      {remoteDiscovery.authors.map((author) => (
                        <button
                          className={
                            remoteSourceForm.authorKeys.includes(author.key)
                              ? "settings-remote-source__author settings-remote-source__author--active"
                              : "settings-remote-source__author"
                          }
                          key={author.key}
                          onClick={() => toggleAuthor(author.key)}
                          type="button"
                        >
                          <span className="settings-remote-source__author-avatar" aria-hidden="true">
                            {author.avatarUrl ? <img alt={author.name} src={author.avatarUrl} /> : <span>{author.name.slice(0, 1).toUpperCase()}</span>}
                          </span>
                          <span>
                            {author.name} · {author.videoCount}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="settings-remote-source__actions">
                <button className="button" disabled={isSavingRemoteSource} onClick={() => void handleSaveRemoteSource()} type="button">
                  {isSavingRemoteSource ? "保存中…" : selectedRemoteSource ? "保存修改" : "创建来源"}
                </button>
                <button
                  className="button--ghost"
                  disabled={isTestingRemoteSource || !selectedRemoteSource}
                  onClick={() => void handleTestRemoteSource()}
                  type="button"
                >
                  {isTestingRemoteSource ? "测试中…" : "测试连接"}
                </button>
                <button
                  className="button--ghost"
                  disabled={isDiscoveringRemoteSource || !selectedRemoteSource}
                  onClick={() => void handleDiscoverRemoteSource()}
                  type="button"
                >
                  {isDiscoveringRemoteSource ? "发现中…" : "发现作者与合集"}
                </button>
                {selectedRemoteSource ? (
                  <button className="button--ghost" disabled={isSavingRemoteSource} onClick={() => void handleDeleteRemoteSource()} type="button">
                    删除来源
                  </button>
                ) : null}
              </div>

              {isLoadingRemoteSources ? <p className="plain-note">正在加载远程来源…</p> : null}
              {remoteSourceError ? <p className="error-text">{remoteSourceError}</p> : null}
              {remoteSourceFeedback ? <p className="plain-note">{remoteSourceFeedback}</p> : null}
            </div>
          )}
        </article>

        <article className="list-card">
          <div>
            <p className="eyebrow">后端服务</p>
            <h3>{health?.service ?? "MikMok API"}</h3>
            <p className="list-card__path">
              {error
                ? error
                : health
                  ? `${health.status} · ${health.environment} · 数据库 ${health.dbFile} · ffmpeg ${health.ffmpegAvailable ? "就绪" : "缺失"} · ffprobe ${health.ffprobeAvailable ? "就绪" : "缺失"} · 任务 ${health.jobs.running} 进行 / ${health.jobs.queued} 排队 / ${health.jobs.failed} 失败`
                  : "正在加载服务状态…"}
            </p>
          </div>
          <span className="pill pill--solid">{health?.transcodeEnabled ? "转码开启" : "转码关闭"}</span>
        </article>

        <article className="list-card">
          <div>
            <p className="eyebrow">最近任务</p>
            <h3>{jobsError ? "任务列表不可用" : "后台处理"}</h3>
            <p className="list-card__path">
              {jobsError
                ? jobsError
                : jobs.length > 0
                  ? "转码任务保存在 SQLite 中，由内置 worker 轮询执行。"
                  : "还没有后台任务记录。"}
            </p>
          </div>
          <div className="stack-list">
            {jobs.map((job) => (
              <article key={job.id} className="list-card">
                <div>
                  <p className="eyebrow">
                    {job.type === "transcode" ? "转码" : job.type} · {translateJobStatus(job.status)}
                  </p>
                  <h3>{job.relatedEntityId ?? job.id}</h3>
                  <p className="list-card__path">
                    {translateJobProgress(job.progressMessage)}
                    {job.progressTotal > 0 ? ` (${job.progressCurrent}/${job.progressTotal})` : ""}
                  </p>
                  <p className="list-card__path">
                    第 {job.attemptCount} 次尝试 · 更新于 {new Date(job.updatedAt * 1000).toLocaleString()}
                  </p>
                  {job.lastError ? <p className="list-card__path">{job.lastError}</p> : null}
                </div>
                <span className="pill">{translateJobStatus(job.status)}</span>
              </article>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}
