import * as THREE from 'three';

const CHROMA_KEY_FRAGMENT = `
uniform sampler2D map;
varying vec2 vUv;

void main() {
  vec4 c = texture2D(map, vUv);
  // 绿幕抠图（推流端背景为 #00FF00）
  float greenness = c.g - max(c.r, c.b);
  if (greenness > 0.22 && c.g > 0.32) discard;
  // 黑底抠图（Android 旧版 fallback）
  float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  if (luma < 0.10) discard;
  gl_FragColor = vec4(c.rgb, 1.0);
}
`;

const CHROMA_KEY_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** 带绿幕/黑底抠图的视频材质 */
export function createVideoMaterial(
  texture: THREE.VideoTexture,
  hasAlpha: boolean,
  effect: 'plane' | 'relief' = 'plane'
): THREE.Material {
  if (!hasAlpha) {
    if (effect === 'relief') {
      return new THREE.MeshStandardMaterial({
        map: texture,
        transparent: true,
        side: THREE.DoubleSide,
        roughness: 0.6,
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
