import { useEffect, useRef } from 'react';

interface RoomQrProps {
  roomId: string;
  serverUrl: string;
}

/** 轻量 QR 码生成（基于 canvas，无外部依赖） */
export function RoomQr({ roomId, serverUrl }: RoomQrProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const joinUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}&server=${encodeURIComponent(serverUrl)}`;
    const size = 120;
    canvas.width = size;
    canvas.height = size;

    import('qrcode').then((QRCode) => {
      QRCode.toCanvas(canvas, joinUrl, { width: size, margin: 1, color: { dark: '#f3f4f6', light: '#111827' } });
    }).catch(() => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#111827';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#f3f4f6';
      ctx.font = '10px monospace';
      ctx.fillText(roomId, 10, size / 2);
    });
  }, [roomId, serverUrl]);

  return (
    <div className="room-qr">
      <canvas ref={canvasRef} />
      <span className="room-qr-label">扫码加入 {roomId}</span>
    </div>
  );
}
