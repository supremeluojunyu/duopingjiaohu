import { SelfieSegmentation } from '@mediapipe/selfie_segmentation';

let segmenter: SelfieSegmentation | null = null;
let initPromise: Promise<SelfieSegmentation> | null = null;

async function getSegmenter(): Promise<SelfieSegmentation> {
  if (segmenter) return segmenter;
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve, reject) => {
    const seg = new SelfieSegmentation({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
    });
    seg.setOptions({ modelSelection: 1 });
    seg.onResults(() => {});
    seg.initialize().then(() => {
      segmenter = seg;
      resolve(seg);
    }).catch(reject);
  });

  return initPromise;
}

export async function applySegmentation(
  sourceVideo: HTMLVideoElement,
  outputCanvas: HTMLCanvasElement
): Promise<void> {
  const seg = await getSegmenter();
  const ctx = outputCanvas.getContext('2d');
  if (!ctx) return;

  outputCanvas.width = sourceVideo.videoWidth || 640;
  outputCanvas.height = sourceVideo.videoHeight || 480;

  return new Promise((resolve) => {
    seg.onResults((results) => {
      ctx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
      ctx.drawImage(results.segmentationMask, 0, 0, outputCanvas.width, outputCanvas.height);
      ctx.globalCompositeOperation = 'source-in';
      ctx.drawImage(results.image, 0, 0, outputCanvas.width, outputCanvas.height);
      ctx.globalCompositeOperation = 'source-over';
      resolve();
    });
    seg.send({ image: sourceVideo });
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
  video.play();

  const canvas = document.createElement('canvas');
  const outputStream = canvas.captureStream(30);
  sourceStream.getAudioTracks().forEach((t) => outputStream.addTrack(t));

  let running = true;
  const process = async () => {
    if (!running) return;
    if (video.readyState >= 2) {
      try {
        await applySegmentation(video, canvas);
      } catch {
        /* fallback to raw */
      }
    }
    requestAnimationFrame(process);
  };
  process();

  return {
    stream: outputStream,
    stop: () => {
      running = false;
      video.srcObject = null;
    },
  };
}
