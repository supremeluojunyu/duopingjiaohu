import * as THREE from 'three';

/** 从视频帧采样亮度深度图 (0~1) */
export function sampleVideoDepth(
  video: HTMLVideoElement,
  sampleW = 64,
  sampleH = 36
): Float32Array {
  const canvas = document.createElement('canvas');
  canvas.width = sampleW;
  canvas.height = sampleH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || video.videoWidth === 0) return new Float32Array(sampleW * sampleH);

  ctx.drawImage(video, 0, 0, sampleW, sampleH);
  const img = ctx.getImageData(0, 0, sampleW, sampleH);
  const depth = new Float32Array(sampleW * sampleH);

  for (let i = 0; i < depth.length; i++) {
    const o = i * 4;
    const lum = (0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]) / 255;
    depth[i] = lum;
  }
  return depth;
}

/** 创建浮雕几何体（高分段平面） */
export function createReliefGeometry(width: number, height: number): THREE.PlaneGeometry {
  return new THREE.PlaneGeometry(width, height, 48, 27);
}

/** 更新浮雕顶点 Z 位移 */
export function updateReliefGeometry(
  geometry: THREE.PlaneGeometry,
  depth: Float32Array,
  depthScale = 0.35
): void {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const segW = geometry.parameters.widthSegments + 1;
  const segH = geometry.parameters.heightSegments + 1;
  const dw = Math.round(Math.sqrt(depth.length * (16 / 9)));
  const dh = Math.max(1, Math.round(depth.length / dw));

  for (let i = 0; i < pos.count; i++) {
    const col = i % segW;
    const row = Math.floor(i / segW);
    const dx = Math.floor(col * dw / segW);
    const dy = Math.floor(row * dh / segH);
    const di = Math.min(dy * dw + dx, depth.length - 1);
    pos.setZ(i, depth[di] * depthScale);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
}

/** 创建点云对象 */
export function createPointCloud(width: number, height: number, sampleW = 48, sampleH = 27): {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  sampleW: number;
  sampleH: number;
} {
  const count = sampleW * sampleH;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let y = 0; y < sampleH; y++) {
    for (let x = 0; x < sampleW; x++) {
      const i = y * sampleW + x;
      positions[i * 3] = (x / sampleW - 0.5) * width;
      positions[i * 3 + 1] = (0.5 - y / sampleH) * height;
      positions[i * 3 + 2] = 0;
      colors[i * 3] = 1;
      colors[i * 3 + 1] = 1;
      colors[i * 3 + 2] = 1;
    }
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 0.04,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    sizeAttenuation: true,
  });

  return { points: new THREE.Points(geometry, material), geometry, sampleW, sampleH };
}

/** 更新点云颜色与深度 */
export function updatePointCloud(
  video: HTMLVideoElement,
  geometry: THREE.BufferGeometry,
  sampleW: number,
  sampleH: number,
  depthScale = 0.5
): void {
  const canvas = document.createElement('canvas');
  canvas.width = sampleW;
  canvas.height = sampleH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || video.videoWidth === 0) return;

  ctx.drawImage(video, 0, 0, sampleW, sampleH);
  const img = ctx.getImageData(0, 0, sampleW, sampleH);
  const positions = geometry.attributes.position as THREE.BufferAttribute;
  const colors = geometry.attributes.color as THREE.BufferAttribute;

  for (let i = 0; i < sampleW * sampleH; i++) {
    const o = i * 4;
    const r = img.data[o] / 255;
    const g = img.data[o + 1] / 255;
    const b = img.data[o + 2] / 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    positions.setZ(i, lum * depthScale);
    colors.setXYZ(i, r, g, b);
  }
  positions.needsUpdate = true;
  colors.needsUpdate = true;
}

export type RenderEffect = 'plane' | 'relief' | 'pointcloud';
