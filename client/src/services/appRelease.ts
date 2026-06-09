export interface AppReleaseInfo {
  versionName: string;
  versionCode: number;
  fileName: string;
  fileSize: number;
  sha256: string;
  updatedAt: string;
  available: boolean;
  releaseNotes: string;
  downloadUrl: string | null;
  versionedDownloadUrl: string | null;
}

function toHttpBase(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, '');
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice(5).replace(/\/ws$/, '')}`;
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice(6).replace(/\/ws$/, '')}`;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed.replace(/\/ws$/, '');
  }
  return trimmed;
}

export async function fetchAppRelease(serverUrl: string): Promise<AppReleaseInfo> {
  const base = toHttpBase(serverUrl);
  const isLocal = /localhost|127\.0\.0\.1/.test(base);
  const url = import.meta.env.DEV && isLocal
    ? `${window.location.origin}/api/app/version`
    : `${base}/api/app/version`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`获取版本失败 (${res.status})`);
  return res.json() as Promise<AppReleaseInfo>;
}

export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatUpdatedAt(iso: string): string {
  if (!iso || iso.startsWith('1970')) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN');
  } catch {
    return iso;
  }
}

export function buildDownloadPageUrl(serverUrl?: string): string {
  const params = new URLSearchParams({ page: 'download' });
  if (serverUrl) params.set('server', serverUrl);
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}
