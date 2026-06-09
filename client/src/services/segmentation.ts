import { SelfieSegmentation } from '@mediapipe/selfie_segmentation';

let segmenter: SelfieSegmentation | null = null;
let initPromise: Promise<SelfieSegmentation> | null = null;
let initError: string | null = null;

function mediapipeAssetUrl(file: string): string {
  return new URL(`../../node_modules/@mediapipe/selfie_segmentation/${file}`, import.meta.url).href;
}

async function getSegmenter(): Promise<SelfieSegmentation> {
  if (segmenter) return segmenter;
  if (initError) throw new Error(initError);
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve, reject) => {
    const seg = new SelfieSegmentation({
      locateFile: mediapipeAssetUrl,
    });
    seg.setOptions({ modelSelection: 1 });
    seg.onResults(() => {});
    seg.initialize()
      .then(() => {
        segmenter = seg;
        resolve(seg);
      })
      .catch((err) => {
        initError = err instanceof Error ? err.message : 'MediaPipe 初始化失败';
        reject(err);
      });
  });

  return initPromise;
}

export function getSegmentationInitError(): string | null {
  return initError;
}

export async function applySegmentation(
  sourceVideo: HTMLVideoElement,
  outputCanvas: HTMLCanvasElement
): Promise<void> {
  const seg = await getSegmenter();
  const ctx = outputCanvas.getContext('2d');
  if (!ctx) return;

  const w = sourceVideo.videoWidth || 640;
  const h = sourceVideo.videoHeight || 480;
  outputCanvas.width = w;
  outputCanvas.height = h;

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('抠图超时')), 3000);
    seg.onResults((results) => {
      window.clearTimeout(timeout);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#00ff00';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(results.image, 0, 0, w, h);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(results.segmentationMask, 0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
      resolve();
    });
    seg.send({ image: sourceVideo }).catch((err) => {
      window.clearTimeout(timeout);
      reject(err);
    });
  });
}

async function waitVideoReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2) return;
  await video.play().catch(() => {});
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('视频未就绪')), 8000);
    video.onloadeddata = () => {
      window.clearTimeout(timer);
      resolve();
    };
  });
}

export function createSegmentedStream(
  sourceStream: MediaStream,
  enabled: boolean
): { stream: MediaStream; stop: () => void } {
  if (!enabled) {
    return { stream: sourceStream, stop: () => {} };
  }

  const video = document.createElement('video');
  video.srcObject = sourceStream;
  video.muted = true;
  video.playsInline = true;

  const canvas = document.createElement('canvas');
  const outputStream = canvas.captureStream(30);
  sourceStream.getAudioTracks().forEach((t) => outputStream.addTrack(t));

  let running = true;
  let processing = false;

  const process = async () => {
    if (!running) return;
    if (!processing && video.readyState >= 2) {
      processing = true;
      try {
        await applySegmentation(video, canvas);
      } catch {
        const ctx = canvas.getContext('2d');
        if (ctx && video.videoWidth > 0) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
        }
      }
      processing = false;
    }
    requestAnimationFrame(process);
  };

  waitVideoReady(video)
    .then(() => process())
    .catch(() => process());

  return {
    stream: outputStream,
    stop: () => {
      running = false;
      video.srcObject = null;
    },
  };
}
