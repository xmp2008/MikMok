import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { useAuth, useLoginRedirect } from "../hooks/useAuth";

export function LoginPage() {
  const { authenticated, login } = useAuth();
  const redirectToFeed = useLoginRedirect();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (authenticated) {
      redirectToFeed();
    }
  }, [authenticated, redirectToFeed]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await login(password);
      redirectToFeed();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "登录失败。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="screen-center">
      <section className="glass-panel">
        <p className="eyebrow">本地私有播放</p>
        <h1>MikMok</h1>
        <p className="hero__blurb">
          家庭服务器上的私人短视频库，竖屏信息流，极简操作界面。
        </p>
        <form className="form-stack" onSubmit={handleSubmit}>
          <label className="field">
            <span>密码</span>
            <input
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="输入部署密码"
              type="password"
              value={password}
            />
          </label>
          {error ? <p className="error-text">{error}</p> : null}
          <button className="button" disabled={submitting} type="submit">
            {submitting ? "登录中…" : "登录"}
          </button>
        </form>
      </section>
    </div>
  );
}
