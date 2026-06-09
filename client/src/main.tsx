import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminPanel } from './components/AdminPanel';
import { AngleGuideOverlay } from './components/AngleGuideOverlay';
import { DeviceList } from './components/DeviceList';
import { PerformancePanel } from './components/PerformancePanel';
import { RoomQr } from './components/RoomQr';
import { ApkDownloadPage } from './components/ApkDownloadPage';
import { useScene3D } from './hooks/useScene3D';
import { shouldReduceQuality, useWebRTCStats } from './hooks/useWebRTCStats';
import { DEFAULT_SIGNALING_URL } from './config';
import { fetchIceServers } from './services/ice';
import { SignalingClient } from './services/signaling';
import { WebRTCManager } from './services/webrtc';
import {
  AngleGuide,
  DeviceInfo,
  RemoteStream,
  ScenePreset,
  StreamMapping,
} from './types';
import './styles.css';

const DEFAULT_SERVER = DEFAULT_SIGNALING_URL;

function getInitialJoinForm() {
  const params = new URLSearchParams(window.location.search);
  return {
    serverUrl: params.get('server') ?? DEFAULT_SERVER,
    roomId: (params.get('room') ?? '').toUpperCase(),
    name: '',
    type: (params.get('type') === 'mobile' ? 'mobile' : 'desktop') as 'mobile' | 'desktop',
    asAdmin: params.get('admin') === '1',
  };
}

function isDownloadPage() {
  const params = new URLSearchParams(window.location.search);
  return params.get('page') === 'download';
}

function App() {
  const [connected, setConnected] = useState(false);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [mappings, setMappings] = useState<StreamMapping[]>([]);
  const [presets, setPresets] = useState<ScenePreset[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, RemoteStream>>(new Map());
  const [latency, setLatency] = useState(0);
  const [subscribed, setSubscribed] = useState<Set<string>>(new Set());
  const [isPublishing, setIsPublishing] = useState(false);
  const [segmentationEnabled, setSegmentationEnabled] = useState(false);
  const [viewMode, setViewMode] = useState<'3d' | 'grid' | 'stereo' | 'relief' | 'pointcloud'>('3d');
  const [angleGuide, setAngleGuide] = useState<AngleGuide | null>(null);
  const [signalConnected, setSignalConnected] = useState(true);
  const [backgroundEnabled, setBackgroundEnabled] = useState(false);
  const [backgroundStream, setBackgroundStream] = useState<MediaStream | null>(null);
  const [qualityReduced, setQualityReduced] = useState(false);
  const [joinForm, setJoinForm] = useState(getInitialJoinForm);
  const [showDownloadPage, setShowDownloadPage] = useState(isDownloadPage);

  const goToDownloadPage = () => {
    const params = new URLSearchParams(window.location.search);
    params.set('page', 'download');
    params.set('server', joinForm.serverUrl);
    const next = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, '', next);
    setShowDownloadPage(true);
  };

  const leaveDownloadPage = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete('page');
    const query = params.toString();
    const next = query ? `${window.location.pathname}?${query}` : window.location.pathname;
    window.history.replaceState(null, '', next);
    setShowDownloadPage(false);
  };

  const signalingRef = useRef<SignalingClient | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const pendingIceRef = useRef<RTCIceServer[] | null>(null);
  const sceneContainerRef = useRef<HTMLDivElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  const getPeers = useCallback(
    () => webrtcRef.current?.getPeerConnections() ?? null,
    []
  );
  const streamStats = useWebRTCStats(getPeers);

  useScene3D(sceneContainerRef, { mappings, remoteStreams, viewMode, backgroundStream });

  // 网络质量自适应降质
  useEffect(() => {
    const reduce = shouldReduceQuality(streamStats);
    if (reduce !== qualityReduced) {
      setQualityReduced(reduce);
      webrtcRef.current?.setQualityMode(reduce);
    }
  }, [streamStats, qualityReduced]);

  const handleSignalingMessage = useCallback((msg: import('./types').SignalingMessage) => {
    switch (msg.type) {
      case 'joined': {
        const payload = msg.payload;
        setRoomId(payload.roomId as string);
        setDevice(payload.device as DeviceInfo);
        setDevices(payload.devices as DeviceInfo[]);
        setMappings(payload.mappings as StreamMapping[]);
        setPresets(payload.presets as ScenePreset[]);
        setConnected(true);

        // 加入后立即初始化 WebRTC，便于仅接收不推流
        const dev = payload.device as DeviceInfo;
        if (signalingRef.current) {
          const webrtc = new WebRTCManager(signalingRef.current, dev.id);
          if (pendingIceRef.current) webrtc.setIceServers(pendingIceRef.current);
          webrtc.setRemoteStreamCallback(setRemoteStreams);
          webrtcRef.current = webrtc;
        }
        break;
      }
      case 'peer_joined': {
        const d = msg.payload.device as DeviceInfo;
        setDevices((prev) => [...prev.filter((x) => x.id !== d.id), d]);
        break;
      }
      case 'peer_left': {
        const id = msg.payload.deviceId as string;
        setDevices((prev) => prev.filter((d) => d.id !== id));
        setSubscribed((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        break;
      }
      case 'mapping_sync': {
        setMappings(msg.payload.mappings as StreamMapping[]);
        if (msg.payload.preset) {
          setPresets((prev) => {
            const p = msg.payload.preset as ScenePreset;
            return prev.some((x) => x.id === p.id) ? prev : [...prev, p];
          });
        }
        break;
      }
      case 'angle_guide':
        setAngleGuide(msg.payload as unknown as AngleGuide);
        break;
      case 'sensor_report': {
        const deviceId = msg.payload.deviceId as string;
        const sensor = msg.payload.sensor as DeviceInfo['sensor'];
        setDevices((prev) =>
          prev.map((d) => (d.id === deviceId ? { ...d, sensor } : d))
        );
        break;
      }
      case 'role_change': {
        const d = msg.payload.device as DeviceInfo;
        setDevices((prev) => prev.map((x) => (x.id === d.id ? d : x)));
        if (device?.id === d.id) setDevice(d);
        break;
      }
      case 'scene_save': {
        const preset = msg.payload.preset as ScenePreset;
        setPresets((prev) => [...prev, preset]);
        break;
      }
      case 'error':
        alert(msg.payload.message as string);
        break;
    }
  }, [device?.id]);

  useEffect(() => {
    if (!device || device.type !== 'mobile') return;

    const reportSensor = () => {
      // DeviceOrientationEvent where available
      signalingRef.current?.send({
        type: 'sensor_report',
        payload: {
          sensor: {
            yaw: (window as unknown as { _lastYaw?: number })._lastYaw ?? 0,
            pitch: (window as unknown as { _lastPitch?: number })._lastPitch ?? 0,
            roll: 0,
          },
        },
      });
    };

    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.alpha != null) (window as unknown as { _lastYaw?: number })._lastYaw = e.alpha;
      if (e.beta != null) (window as unknown as { _lastPitch?: number })._lastPitch = e.beta - 90;
      reportSensor();
    };

    window.addEventListener('deviceorientation', onOrientation);
    return () => window.removeEventListener('deviceorientation', onOrientation);
  }, [device]);

  const joinRoom = async () => {
    const name = joinForm.name.trim() || (joinForm.type === 'mobile' ? '手机' : '电脑');
    const signaling = new SignalingClient(joinForm.serverUrl);
    signaling.setLatencyCallback(setLatency);
    signaling.setConnectionCallback(setSignalConnected);
    signaling.onMessage(handleSignalingMessage);

    const joinPayload = {
      roomId: joinForm.roomId.trim() || undefined,
      device: {
        name,
        type: joinForm.type,
        role: joinForm.asAdmin ? 'admin' : 'user',
        streamTypes: ['camera'],
        hasAlpha: segmentationEnabled,
      },
    };
    signaling.setJoinPayload(joinPayload);

    await signaling.connect();
    signalingRef.current = signaling;

    const iceServers = await fetchIceServers(joinForm.serverUrl);

    signaling.send({ type: 'join', payload: joinPayload });

    // ICE 配置在 joined 后应用到 WebRTC
    pendingIceRef.current = iceServers;
  };

  const startPublishing = async (includeScreen = false) => {
    if (!signalingRef.current || !device) return;
    if (!webrtcRef.current) {
      webrtcRef.current = new WebRTCManager(signalingRef.current, device.id);
      webrtcRef.current.setRemoteStreamCallback(setRemoteStreams);
    }

    const streamTypes: ('camera' | 'screen')[] = includeScreen ? ['camera', 'screen'] : ['camera'];
    const stream = await webrtcRef.current.startPublishing(streamTypes, segmentationEnabled);
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }
    setIsPublishing(true);
  };

  const stopPublishing = () => {
    webrtcRef.current?.stopPublishing();
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    setIsPublishing(false);
  };

  const handleSubscribe = async (deviceId: string) => {
    await webrtcRef.current?.subscribe(deviceId, 'camera');
    setSubscribed((prev) => new Set(prev).add(deviceId));
    signalingRef.current?.send({
      type: 'subscribe',
      payload: { publisherId: deviceId, streamType: 'camera' },
    });
  };

  const handleUnsubscribe = (deviceId: string) => {
    webrtcRef.current?.unsubscribe(deviceId, 'camera');
    setSubscribed((prev) => {
      const next = new Set(prev);
      next.delete(deviceId);
      return next;
    });
  };

  const handleMappingChange = (mapping: StreamMapping) => {
    signalingRef.current?.send({
      type: 'mapping_update',
      payload: { mapping },
    });
    setMappings((prev) =>
      prev.map((m) =>
        m.deviceId === mapping.deviceId && m.streamType === mapping.streamType ? mapping : m
      )
    );
  };

  const handleSendAngleGuide = (deviceId: string, yaw: number, pitch: number) => {
    signalingRef.current?.send({
      type: 'angle_guide',
      payload: {
        targetDeviceId: deviceId,
        targetYaw: yaw,
        targetPitch: pitch,
        tolerance: 5,
        message: `请将手机调整至 Yaw ${yaw.toFixed(0)}° / Pitch ${pitch.toFixed(0)}°`,
      },
    });
  };

  const handleSaveScene = (name: string) => {
    signalingRef.current?.send({
      type: 'scene_save',
      payload: { name, layout: 'semicircle', mappings },
    });
  };

  const handleLoadPreset = (presetId: string) => {
    signalingRef.current?.send({ type: 'scene_load', payload: { presetId } });
  };

  const toggleAdmin = () => {
    if (!device) return;
    signalingRef.current?.send({
      type: 'role_change',
      payload: { deviceId: device.id, role: device.role === 'admin' ? 'user' : 'admin' },
    });
    setDevice({ ...device, role: device.role === 'admin' ? 'user' : 'admin' });
  };

  const openHologramOutput = () => {
    const url = window.location.href;
    window.open(url + (url.includes('?') ? '&' : '?') + 'hologram=1', '_blank', 'fullscreen=yes');
  };

  const toggleBackgroundFusion = async () => {
    if (backgroundEnabled) {
      backgroundStream?.getTracks().forEach((t) => t.stop());
      setBackgroundStream(null);
      setBackgroundEnabled(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: 1920, height: 1080 },
        audio: false,
      });
      setBackgroundStream(stream);
      setBackgroundEnabled(true);
    } catch {
      alert('无法访问背景摄像头');
    }
  };

  if (showDownloadPage) {
    return (
      <ApkDownloadPage
        serverUrl={joinForm.serverUrl}
        onBack={leaveDownloadPage}
      />
    );
  }

  if (!connected) {
    return (
      <div className="join-screen">
        <div className="join-card">
          <h1>全息投影 · 多屏互动系统</h1>
          <p className="subtitle">跨平台实时视频交互 · MVP v0.1</p>

          <label>信令服务器</label>
          <input
            value={joinForm.serverUrl}
            onChange={(e) => setJoinForm({ ...joinForm, serverUrl: e.target.value })}
          />

          <label>房间号（留空自动创建）</label>
          <input
            value={joinForm.roomId}
            onChange={(e) => setJoinForm({ ...joinForm, roomId: e.target.value.toUpperCase() })}
            placeholder="例如 ABC123"
          />

          <label>设备名称</label>
          <input
            value={joinForm.name}
            onChange={(e) => setJoinForm({ ...joinForm, name: e.target.value })}
            placeholder="我的设备"
          />

          <label>设备类型</label>
          <select
            value={joinForm.type}
            onChange={(e) => setJoinForm({ ...joinForm, type: e.target.value as 'mobile' | 'desktop' })}
          >
            <option value="desktop">电脑</option>
            <option value="mobile">手机</option>
          </select>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={joinForm.asAdmin}
              onChange={(e) => setJoinForm({ ...joinForm, asAdmin: e.target.checked })}
            />
            以管理员身份加入
          </label>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={segmentationEnabled}
              onChange={(e) => setSegmentationEnabled(e.target.checked)}
            />
            开启人像抠图
          </label>

          <button className="btn-primary" onClick={joinRoom}>进入房间</button>

          <button className="btn-link" type="button" onClick={goToDownloadPage}>
            下载 Android 客户端
          </button>
        </div>
      </div>
    );
  }

  const isAdmin = device?.role === 'admin';

  return (
    <div className="app-layout">
      <header className="toolbar">
        <div className="toolbar-left">
          <span className="logo">◈ 全息系统</span>
          <span className="room-badge">房间 {roomId}</span>
          <span className={`latency ${signalConnected ? '' : 'offline'}`}>
            {signalConnected ? `${latency}ms` : '重连中...'}
          </span>
        </div>
        <div className="toolbar-center">
          <button className={viewMode === '3d' ? 'active' : ''} onClick={() => setViewMode('3d')}>3D</button>
          <button className={viewMode === 'relief' ? 'active' : ''} onClick={() => setViewMode('relief')}>浮雕</button>
          <button className={viewMode === 'pointcloud' ? 'active' : ''} onClick={() => setViewMode('pointcloud')}>点云</button>
          <button className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')}>网格</button>
          <button className={viewMode === 'stereo' ? 'active' : ''} onClick={() => setViewMode('stereo')}>立体对</button>
        </div>
        <div className="toolbar-right">
          {!isPublishing ? (
            <>
              <button className="btn-primary" onClick={() => startPublishing(false)}>摄像头投屏</button>
              {device?.type === 'desktop' && (
                <button onClick={() => startPublishing(true)}>屏幕+摄像头</button>
              )}
            </>
          ) : (
            <button className="btn-danger" onClick={stopPublishing}>停止投屏</button>
          )}
          <button className={backgroundEnabled ? 'active' : ''} onClick={toggleBackgroundFusion}>
            {backgroundEnabled ? '关闭背景' : '虚实融合'}
          </button>
          <button onClick={toggleAdmin}>
            {isAdmin ? '退出管理' : '管理员模式'}
          </button>
          <button onClick={openHologramOutput}>全息输出</button>
        </div>
      </header>

      <div className="main-content">
        <aside className="sidebar left">
          {roomId && (
            <RoomQr roomId={roomId} serverUrl={joinForm.serverUrl} />
          )}
          <DeviceList
            devices={devices}
            localDeviceId={device?.id ?? null}
            subscribed={subscribed}
            onSubscribe={handleSubscribe}
            onUnsubscribe={handleUnsubscribe}
          />
        </aside>

        <main className="viewport">
          {viewMode === 'grid' ? (
            <div className="grid-view">
              {[...remoteStreams.values()].map((rs) => (
                <GridVideo key={`${rs.deviceId}:${rs.streamType}`} stream={rs.stream} label={rs.deviceId.slice(0, 8)} />
              ))}
              {remoteStreams.size === 0 && (
                <div className="empty-viewport">订阅设备画面后将在此显示</div>
              )}
            </div>
          ) : (
            <div ref={sceneContainerRef} className="scene-container" />
          )}

          {isPublishing && (
            <div className="local-preview">
              <video ref={localVideoRef} autoPlay muted playsInline />
              <span>本地预览</span>
            </div>
          )}

          <AngleGuideOverlay
            guide={angleGuide}
            currentSensor={device?.sensor}
          />
        </main>

        <aside className="sidebar right">
          <PerformancePanel
            stats={streamStats}
            latency={latency}
            roomDeviceCount={devices.length}
            qualityReduced={qualityReduced}
          />
          <div className="thumbnails">
            <h3>画面缩略图</h3>
            {[...remoteStreams.values()].map((rs) => (
              <GridVideo key={`thumb-${rs.deviceId}`} stream={rs.stream} label={rs.deviceId.slice(0, 8)} small />
            ))}
          </div>
        </aside>
      </div>

      {isAdmin && (
        <AdminPanel
          devices={devices}
          mappings={mappings}
          onMappingChange={handleMappingChange}
          onSendAngleGuide={handleSendAngleGuide}
          onSaveScene={handleSaveScene}
          presets={presets}
          onLoadPreset={handleLoadPreset}
        />
      )}
    </div>
  );
}

function GridVideo({ stream, label, small }: { stream: MediaStream; label: string; small?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className={`grid-video ${small ? 'small' : ''}`}>
      <video ref={ref} autoPlay playsInline muted />
      <span>{label}</span>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
