import * as THREE from 'three';

const CHROMA_KEY_FRAGMENT = `
uniform sampler2D map;
varying vec2 vUv;

void main() {
  vec4 c = texture2D(map, vUv);
  float greenness = c.g - max(c.r, c.b);
  float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));

  // 绿幕区域：平滑过渡为透明
  float key = smoothstep(0.08, 0.28, greenness) * step(0.22, c.g);
  // 纯黑背景也去掉
  float black = 1.0 - smoothstep(0.0, 0.14, luma);
  float alpha = 1.0 - max(key, black * step(greenness, 0.05));

  if (alpha < 0.04) discard;
  gl_FragColor = vec4(c.rgb, alpha);
}
`;

const CHROMA_KEY_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** 视频纹理统一配置：线性滤波、关闭 mipmap（动态视频每帧更新） */
export function configureVideoTexture(texture: THREE.VideoTexture): void {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
}

/** 带绿幕/黑底抠图的视频材质 */
export function createVideoMaterial(
  texture: THREE.VideoTexture,
  hasAlpha: boolean,
  effect: 'plane' | 'relief' = 'plane'
): THREE.Material {
  configureVideoTexture(texture);

  if (!hasAlpha) {
    if (effect === 'relief') {
      return new THREE.MeshStandardMaterial({
        map: texture,
        transparent: true,
        side: THREE.DoubleSide,
        roughness: 0.8,
        metalness: 0,
      });
    }
    return new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
    });
  }

  return new THREE.ShaderMaterial({
    uniforms: { map: { value: texture } },
    vertexShader: CHROMA_KEY_VERTEX,
    fragmentShader: CHROMA_KEY_FRAGMENT,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

/** 2D 网格视图用的绿幕抠图（Canvas） */
export function drawChromaKeyedFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || video.readyState < 2 || video.videoWidth === 0) return;

  const w = video.videoWidth;
  const h = video.videoHeight;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  ctx.drawImage(video, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!;
    const g = d[i + 1]!;
    const b = d[i + 2]!;
    const greenness = g - Math.max(r, b);
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;

    if ((greenness > 28 && g > 56) || (luma < 36 && greenness < 14)) {
      d[i + 3] = 0;
    }
  }

  ctx.putImageData(image, 0, 0);
}
