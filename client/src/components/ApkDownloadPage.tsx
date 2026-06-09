import { useEffect, useRef, useState } from 'react';
import {
  AppReleaseInfo,
  buildDownloadPageUrl,
  fetchAppRelease,
  formatFileSize,
  formatUpdatedAt,
} from '../services/appRelease';
import { DEFAULT_SIGNALING_URL } from '../config';

interface ApkDownloadPageProps {
  serverUrl?: string;
  onBack?: () => void;
}

const POLL_MS = 30_000;

export function ApkDownloadPage({ serverUrl, onBack }: ApkDownloadPageProps) {
  const [signalingUrl, setSignalingUrl] = useState(serverUrl ?? DEFAULT_SIGNALING_URL);
  const [release, setRelease] = useState<AppReleaseInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasUpdate, setHasUpdate] = useState(false);
  const lastVersionCode = useRef<number | null>(null);
  const pageQrRef = useRef<HTMLCanvasElement>(null);
  const apkQrRef = useRef<HTMLCanvasElement>(null);

  const loadRelease = async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const info = await fetchAppRelease(signalingUrl);
      if (lastVersionCode.current != null && info.versionCode > lastVersionCode.current) {
        setHasUpdate(true);
      }
      lastVersionCode.current = info.versionCode;
      setRelease(info);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
      setRelease(null);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    loadRelease();
    const timer = window.setInterval(() => loadRelease(true), POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signalingUrl]);

  const pageUrl = buildDownloadPageUrl(signalingUrl);
  const apkUrl = release?.downloadUrl ?? null;

  useEffect(() => {
    const renderQr = (canvas: HTMLCanvasElement | null, url: string, size: number) => {
      if (!canvas || !url) return;
      canvas.width = size;
      canvas.height = size;
      import('qrcode').then((QRCode) => {
        QRCode.toCanvas(canvas, url, {
          width: size,
          margin: 1,
          color: { dark: '#f3f4f6', light: '#111827' },
        });
      }).catch(() => {});
    };

    renderQr(pageQrRef.current, pageUrl, 180);
    if (apkUrl) renderQr(apkQrRef.current, apkUrl, 140);
  }, [pageUrl, apkUrl]);

  const handleDownload = () => {
    if (!release?.downloadUrl) return;
    window.location.href = release.downloadUrl;
  };

  return (
    <div className="download-screen">
      <div className="download-card">
        <div className="download-header">
          <h1>Android 客户端下载</h1>
          <p className="subtitle">扫码或点击下载 · 版本自动同步</p>
        </div>

        <label>信令服务器（APK 托管地址）</label>
        <input
          value={signalingUrl}
          onChange={(e) => setSignalingUrl(e.target.value)}
          placeholder="http://124.220.4.69:9000"
        />

        {loading && !release && <p className="download-hint">正在获取版本信息...</p>}
        {error && <p className="download-error">{error}</p>}

        {release && (
          <div className="download-info">
            <div className="version-row">
              <span className="version-badge">v{release.versionName}</span>
              <span className="version-code">Build {release.versionCode}</span>
              {hasUpdate && <span className="update-badge">有新版本</span>}
            </div>
            <p className="release-notes">{release.releaseNotes}</p>
            <dl className="meta-list">
              <div><dt>文件大小</dt><dd>{formatFileSize(release.fileSize)}</dd></div>
              <div><dt>更新时间</dt><dd>{formatUpdatedAt(release.updatedAt)}</dd></div>
              <div><dt>状态</dt><dd>{release.available ? '可下载' : '暂未发布'}</dd></div>
            </dl>
          </div>
        )}

        <button
          className="btn-primary"
          disabled={!release?.available || !release.downloadUrl}
          onClick={handleDownload}
        >
          {release?.available ? '下载 APK' : '暂无安装包'}
        </button>

        <div className="download-qr-grid">
          <div className="download-qr-block">
            <canvas ref={pageQrRef} />
            <span>扫码打开下载页</span>
          </div>
          {release?.available && release.downloadUrl && (
            <div className="download-qr-block">
              <canvas ref={apkQrRef} />
              <span>扫码直接下载 APK</span>
            </div>
          )}
        </div>

        <p className="download-hint">
          管理员发布新版本：在服务器运行 <code>bash scripts/publish-apk.sh release</code>
        </p>

        {onBack && (
          <button className="btn-secondary" onClick={onBack}>返回加入房间</button>
        )}
      </div>
    </div>
  );
}
