import { SelfieSegmentation } from '@mediapipe/selfie_segmentation';

let segmenter: SelfieSegmentation | null = null;
let initPromise: Promise<SelfieSegmentation> | null = null;
let initError: string | null = null;

const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d');
const personCanvas = document.createElement('canvas');
const personCtx = personCanvas.getContext('2d');

function ensureMaskCanvas(w: number, h: number): CanvasRenderingContext2D | null {
  if (!maskCtx) return null;
  if (maskCanvas.width !== w) maskCanvas.width = w;
  if (maskCanvas.height !== h) maskCanvas.height = h;
  return maskCtx;
}

function ensurePersonCanvas(w: number, h: number): CanvasRenderingContext2D | null {
  if (!personCtx) return null;
  if (personCanvas.width !== w) personCanvas.width = w;
  if (personCanvas.height !== h) personCanvas.height = h;
  return personCtx;
}

/** 对分割 mask 做高斯模糊，软化抠图边缘 */
function blurSegmentationMask(
  mask: CanvasImageSource,
  w: number,
  h: number,
  blurPx = 2
): HTMLCanvasElement {
  const ctx = ensureMaskCanvas(w, h);
  if (!ctx) return maskCanvas;

  ctx.clearRect(0, 0, w, h);
  ctx.filter = `blur(${blurPx}px)`;
  ctx.drawImage(mask, 0, 0, w, h);
  ctx.filter = 'none';
  return maskCanvas;
}

type SegmentationResults = {
  segmentationMask: CanvasImageSource;
  image: CanvasImageSource;
};

/** 将清晰人像绘制到离屏 canvas，供叠加使用 */
function renderPersonLayer(results: SegmentationResults, w: number, h: number): HTMLCanvasElement {
  const ctx = ensurePersonCanvas(w, h);
  if (!ctx) return personCanvas;

  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  const softMask = blurSegmentationMask(results.segmentationMask, w, h);
  ctx.drawImage(softMask, 0, 0, w, h);
  ctx.globalCompositeOperation = 'source-in';
  ctx.drawImage(results.image, 0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  return personCanvas;
}

async function runSegmentation(
  sourceVideo: HTMLVideoElement,
  outputCanvas: HTMLCanvasElement,
  compose: (
    ctx: CanvasRenderingContext2D,
    results: SegmentationResults,
    w: number,
    h: number
  ) => void
): Promise<void> {
  const seg = await getSegmenter();
  const ctx = outputCanvas.getContext('2d');
  if (!ctx) return;

  const w = sourceVideo.videoWidth || 640;
  const h = sourceVideo.videoHeight || 480;
  outputCanvas.width = w;
  outputCanvas.height = h;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('抠图超时'));
    }, 3000);
    seg.onResults((results) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      compose(ctx, results, w, h);
      resolve();
    });
    seg.send({ image: sourceVideo }).catch((err) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      reject(err);
    });
  });
}

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
    seg.setOptions({ modelSelection: 0 });
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
  return runSegmentation(sourceVideo, outputCanvas, (ctx, results, w, h) => {
    ctx.clearRect(0, 0, w, h);
    // 非人像区域保持绿幕，供接收端色键抠透明
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(renderPersonLayer(results, w, h), 0, 0, w, h);
  });
}

/** 背景虚化：模糊原图作底，叠加清晰人像 */
export async function applySegmentationWithBlur(
  sourceVideo: HTMLVideoElement,
  outputCanvas: HTMLCanvasElement,
  blurPx = 20
): Promise<void> {
  return runSegmentation(sourceVideo, outputCanvas, (ctx, results, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.filter = `blur(${blurPx}px)`;
    ctx.drawImage(sourceVideo, 0, 0, w, h);
    ctx.filter = 'none';
    ctx.drawImage(renderPersonLayer(results, w, h), 0, 0, w, h);
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
  let frameCount = 0;
  let hasSegmentedFrame = false;

  const drawRawFrame = () => {
    const ctx = canvas.getContext('2d');
    if (!ctx || video.videoWidth === 0) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
  };

  const process = async () => {
    if (!running) return;
    if (!processing && video.readyState >= 2) {
      processing = true;
      frameCount++;
      // 每 2 帧推理 1 次，跳帧时复用上一帧抠图结果，避免闪烁
      const shouldSegment = frameCount % 2 === 1;
      try {
        if (shouldSegment) {
          await applySegmentationWithBlur(video, canvas);
          hasSegmentedFrame = true;
        } else if (hasSegmentedFrame) {
          const ctx = canvas.getContext('2d');
          if (ctx && video.videoWidth > 0) {
            const w = video.videoWidth;
            const h = video.videoHeight;
            canvas.width = w;
            canvas.height = h;
            ctx.clearRect(0, 0, w, h);
            ctx.filter = 'blur(20px)';
            ctx.drawImage(video, 0, 0, w, h);
            ctx.filter = 'none';
            ctx.drawImage(personCanvas, 0, 0, w, h);
          }
        } else {
          drawRawFrame();
        }
      } catch {
        drawRawFrame();
        hasSegmentedFrame = false;
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
