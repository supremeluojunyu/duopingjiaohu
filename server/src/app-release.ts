import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface AppReleaseInfo {
  versionName: string;
  versionCode: number;
  fileName: string;
  fileSize: number;
  sha256: string;
  updatedAt: string;
  available: boolean;
  releaseNotes: string;
}

export interface DesktopReleaseInfo {
  versionName: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  updatedAt: string;
  available: boolean;
  releaseNotes: string;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.resolve(moduleDir, '../public/downloads');
const VERSION_FILE = path.join(DOWNLOADS_DIR, 'version.json');
const DESKTOP_VERSION_FILE = path.join(DOWNLOADS_DIR, 'desktop-version.json');
const LATEST_APK = 'app-latest.apk';
const LATEST_EXE = 'app-latest.exe';

const DEFAULT_RELEASE: AppReleaseInfo = {
  versionName: '0.1.0',
  versionCode: 1,
  fileName: '',
  fileSize: 0,
  sha256: '',
  updatedAt: new Date(0).toISOString(),
  available: false,
  releaseNotes: '暂无可用安装包，请使用 scripts/publish-apk.sh 发布 APK',
};

const DEFAULT_DESKTOP_RELEASE: DesktopReleaseInfo = {
  versionName: '0.0.0',
  fileName: '',
  fileSize: 0,
  sha256: '',
  updatedAt: new Date(0).toISOString(),
  available: false,
  releaseNotes: '暂无可用桌面端，请等待 CI 发布或运行 scripts/publish-exe.sh',
};

export function getDownloadsDir(): string {
  return DOWNLOADS_DIR;
}

export function ensureDownloadsDir(): void {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

export function readReleaseInfo(): AppReleaseInfo {
  ensureDownloadsDir();
  if (!fs.existsSync(VERSION_FILE)) {
    writeReleaseInfo(DEFAULT_RELEASE);
    return { ...DEFAULT_RELEASE };
  }
  try {
    const raw = fs.readFileSync(VERSION_FILE, 'utf8');
    return { ...DEFAULT_RELEASE, ...JSON.parse(raw) as Partial<AppReleaseInfo> };
  } catch {
    return { ...DEFAULT_RELEASE };
  }
}

export function writeReleaseInfo(info: AppReleaseInfo): void {
  ensureDownloadsDir();
  fs.writeFileSync(VERSION_FILE, JSON.stringify(info, null, 2));
}

export function resolveApkPath(info: AppReleaseInfo): string | null {
  if (!info.available) return null;
  const candidates = [
    path.join(DOWNLOADS_DIR, LATEST_APK),
    info.fileName ? path.join(DOWNLOADS_DIR, info.fileName) : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function publishApkFromFile(
  sourceApk: string,
  meta: Pick<AppReleaseInfo, 'versionName' | 'versionCode' | 'releaseNotes'>
): AppReleaseInfo {
  ensureDownloadsDir();
  if (!fs.existsSync(sourceApk)) {
    throw new Error(`APK 不存在: ${sourceApk}`);
  }

  const fileName = `holographic-${meta.versionName}.apk`;
  const versionedPath = path.join(DOWNLOADS_DIR, fileName);
  const latestPath = path.join(DOWNLOADS_DIR, LATEST_APK);

  fs.copyFileSync(sourceApk, versionedPath);
  fs.copyFileSync(sourceApk, latestPath);

  const buffer = fs.readFileSync(latestPath);
  const info: AppReleaseInfo = {
    versionName: meta.versionName,
    versionCode: meta.versionCode,
    fileName,
    fileSize: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    updatedAt: new Date().toISOString(),
    available: true,
    releaseNotes: meta.releaseNotes,
  };

  writeReleaseInfo(info);
  return info;
}

export function publishApkFromBuffer(
  buffer: Buffer,
  meta: Pick<AppReleaseInfo, 'versionName' | 'versionCode' | 'releaseNotes'>
): AppReleaseInfo {
  ensureDownloadsDir();
  const fileName = `holographic-${meta.versionName}.apk`;
  const versionedPath = path.join(DOWNLOADS_DIR, fileName);
  const latestPath = path.join(DOWNLOADS_DIR, LATEST_APK);

  fs.writeFileSync(versionedPath, buffer);
  fs.writeFileSync(latestPath, buffer);

  const info: AppReleaseInfo = {
    versionName: meta.versionName,
    versionCode: meta.versionCode,
    fileName,
    fileSize: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    updatedAt: new Date().toISOString(),
    available: true,
    releaseNotes: meta.releaseNotes,
  };

  writeReleaseInfo(info);
  return info;
}

export function toPublicRelease(info: AppReleaseInfo, baseUrl: string) {
  const apkPath = resolveApkPath(info);
  const downloadUrl = info.available && apkPath
    ? `${baseUrl}/downloads/${LATEST_APK}`
    : null;

  return {
    ...info,
    downloadUrl,
    versionedDownloadUrl: info.available && info.fileName
      ? `${baseUrl}/downloads/${info.fileName}`
      : null,
  };
}

export function readDesktopReleaseInfo(): DesktopReleaseInfo {
  ensureDownloadsDir();
  if (!fs.existsSync(DESKTOP_VERSION_FILE)) {
    writeDesktopReleaseInfo(DEFAULT_DESKTOP_RELEASE);
    return { ...DEFAULT_DESKTOP_RELEASE };
  }
  try {
    const raw = fs.readFileSync(DESKTOP_VERSION_FILE, 'utf8');
    return { ...DEFAULT_DESKTOP_RELEASE, ...JSON.parse(raw) as Partial<DesktopReleaseInfo> };
  } catch {
    return { ...DEFAULT_DESKTOP_RELEASE };
  }
}

export function writeDesktopReleaseInfo(info: DesktopReleaseInfo): void {
  ensureDownloadsDir();
  fs.writeFileSync(DESKTOP_VERSION_FILE, JSON.stringify(info, null, 2));
}

export function resolveExePath(info: DesktopReleaseInfo): string | null {
  if (!info.available) return null;
  const candidates = [
    path.join(DOWNLOADS_DIR, LATEST_EXE),
    info.fileName ? path.join(DOWNLOADS_DIR, info.fileName) : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function publishExeFromBuffer(
  buffer: Buffer,
  meta: Pick<DesktopReleaseInfo, 'versionName' | 'releaseNotes'>
): DesktopReleaseInfo {
  ensureDownloadsDir();
  const desktopVersion = meta.versionName.replace(
    /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
    '$1.$2.$3-$4'
  );
  const fileName = `HolographicSystem-Portable-${desktopVersion}.exe`;
  const versionedPath = path.join(DOWNLOADS_DIR, fileName);
  const latestPath = path.join(DOWNLOADS_DIR, LATEST_EXE);

  fs.writeFileSync(versionedPath, buffer);
  fs.writeFileSync(latestPath, buffer);

  const info: DesktopReleaseInfo = {
    versionName: meta.versionName,
    fileName,
    fileSize: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    updatedAt: new Date().toISOString(),
    available: true,
    releaseNotes: meta.releaseNotes,
  };

  writeDesktopReleaseInfo(info);
  return info;
}

export function toPublicDesktopRelease(info: DesktopReleaseInfo, baseUrl: string) {
  const exePath = resolveExePath(info);
  const downloadUrl = info.available && exePath
    ? `${baseUrl}/downloads/${LATEST_EXE}`
    : null;

  return {
    ...info,
    downloadUrl,
    versionedDownloadUrl: info.available && info.fileName
      ? `${baseUrl}/downloads/${info.fileName}`
      : null,
  };
}
