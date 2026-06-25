import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RemoteStream, StreamMapping } from '../types';
import {
  createPointCloud,
  createReliefGeometry,
  RenderEffect,
  sampleVideoDepth,
  updatePointCloud,
  updateReliefGeometry,
} from '../utils/sceneEffects';
import { configureVideoTexture, createVideoMaterial } from '../utils/chromaKeyMaterial';

interface Scene3DProps {
  mappings: StreamMapping[];
  remoteStreams: Map<string, RemoteStream>;
  viewMode: '3d' | 'grid' | 'stereo' | 'relief' | 'pointcloud';
  backgroundStream?: MediaStream | null;
}

interface StreamObject {
  mesh?: THREE.Mesh;
  points?: THREE.Points;
  reliefGeo?: THREE.PlaneGeometry;
  video: HTMLVideoElement;
  texture?: THREE.VideoTexture;
  effect: RenderEffect;
}

type SceneState = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  streamObjects: Map<string, StreamObject>;
  animationId: number;
  frameTick: number;
};

function toRenderEffect(viewMode: Scene3DProps['viewMode']): RenderEffect {
  if (viewMode === 'relief') return 'relief';
  if (viewMode === 'pointcloud') return 'pointcloud';
  return 'plane';
}

function disposeStreamDisplay(obj: StreamObject): void {
  if (obj.mesh) {
    obj.mesh.geometry.dispose();
    (obj.mesh.material as THREE.Material).dispose();
    obj.mesh = undefined;
  }
  if (obj.points) {
    obj.points.geometry.dispose();
    (obj.points.material as THREE.Material).dispose();
    obj.points = undefined;
  }
  obj.reliefGeo = undefined;
  obj.texture?.dispose();
  obj.texture = undefined;
}

function getStreamDisplayObject(obj: StreamObject): THREE.Object3D | undefined {
  return obj.mesh ?? obj.points;
}

function updateStreamTransform(displayObject: THREE.Object3D, mapping: StreamMapping): void {
  displayObject.position.set(mapping.position.x, mapping.position.y, mapping.position.z);
  displayObject.rotation.set(
    THREE.MathUtils.degToRad(mapping.rotation.pitch),
    THREE.MathUtils.degToRad(mapping.rotation.yaw),
    THREE.MathUtils.degToRad(mapping.rotation.roll)
  );
  displayObject.scale.setScalar(mapping.scale);
  displayObject.lookAt(0, mapping.position.y, 0);
}

function rebuildStreamDisplay(
  ref: SceneState,
  obj: StreamObject,
  remote: RemoteStream,
  mapping: StreamMapping,
  effect: RenderEffect
): void {
  if (obj.mesh) ref.scene.remove(obj.mesh);
  if (obj.points) ref.scene.remove(obj.points);
  disposeStreamDisplay(obj);

  const tex = new THREE.VideoTexture(obj.video);
  obj.texture = tex;
  obj.effect = effect;

  let displayObject: THREE.Object3D;

  if (effect === 'relief') {
    const geo = createReliefGeometry(1.6, 0.9);
    obj.reliefGeo = geo;
    const mat = createVideoMaterial(tex, remote.hasAlpha, 'relief');
    obj.mesh = new THREE.Mesh(geo, mat);
    displayObject = obj.mesh;
  } else if (effect === 'pointcloud') {
    const { points, geometry, sampleW, sampleH } = createPointCloud(1.6, 0.9);
    geometry.userData.sampleW = sampleW;
    geometry.userData.sampleH = sampleH;
    obj.points = points;
    displayObject = points;
  } else {
    const mat = createVideoMaterial(tex, remote.hasAlpha, 'plane');
    obj.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.9), mat);
    displayObject = obj.mesh;
  }

  ref.scene.add(displayObject);
  updateStreamTransform(displayObject, mapping);
}

export function useScene3D(
  containerRef: React.RefObject<HTMLDivElement | null>,
  { mappings, remoteStreams, viewMode, backgroundStream }: Scene3DProps
) {
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  const sceneRef = useRef<SceneState | null>(null);
  const mappingsRef = useRef(mappings);
  const remoteStreamsRef = useRef(remoteStreams);
  mappingsRef.current = mappings;
  remoteStreamsRef.current = remoteStreams;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0e17);

    const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 100);
    camera.position.set(0, 2, 6);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(10, 15, 10);
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0x60a5fa, 0.3);
    fillLight.position.set(-10, 5, -10);
    scene.add(fillLight);

    scene.add(new THREE.GridHelper(10, 20, 0x1e3a5f, 0x0f172a));
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(5, 64),
      new THREE.MeshStandardMaterial({ color: 0x111827, transparent: true, opacity: 0.5 })
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    let isDragging = false;
    let prevX = 0;
    let prevY = 0;
    let camYaw = 0;
    let camPitch = 0.2;
    let camDist = 6;

    const onMouseDown = (e: MouseEvent) => {
      isDragging = true;
      prevX = e.clientX;
      prevY = e.clientY;
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      camYaw += (e.clientX - prevX) * 0.005;
      camPitch = Math.max(-0.5, Math.min(1.2, camPitch + (e.clientY - prevY) * 0.005));
      prevX = e.clientX;
      prevY = e.clientY;
    };
    const onMouseUp = () => {
      isDragging = false;
    };
    const onWheel = (e: WheelEvent) => {
      camDist = Math.max(2, Math.min(15, camDist + e.deltaY * 0.01));
    };

    renderer.domElement.addEventListener('mousedown', onMouseDown);
    renderer.domElement.addEventListener('mousemove', onMouseMove);
    renderer.domElement.addEventListener('mouseup', onMouseUp);
    renderer.domElement.addEventListener('wheel', onWheel);

    sceneRef.current = { scene, camera, renderer, streamObjects: new Map(), animationId: 0, frameTick: 0 };

    const animate = () => {
      const ref = sceneRef.current;
      if (!ref) return;
      ref.frameTick++;

      ref.camera.position.x = Math.sin(camYaw) * Math.cos(camPitch) * camDist;
      ref.camera.position.y = Math.sin(camPitch) * camDist + 1.5;
      ref.camera.position.z = Math.cos(camYaw) * Math.cos(camPitch) * camDist;
      ref.camera.lookAt(0, 1.2, 0);

      const isStereo = viewModeRef.current === 'stereo';
      ref.camera.aspect = isStereo
        ? container.clientWidth / container.clientHeight / 2
        : container.clientWidth / container.clientHeight;
      ref.renderer.setScissorTest(isStereo);
      ref.camera.updateProjectionMatrix();

      if (ref.frameTick % 3 === 0) {
        for (const [, obj] of ref.streamObjects) {
          if (obj.video.readyState < 2) continue;
          if (obj.effect === 'relief' && obj.reliefGeo) {
            const depth = sampleVideoDepth(obj.video);
            updateReliefGeometry(obj.reliefGeo, depth);
          } else if (obj.effect === 'pointcloud' && obj.points) {
            const sw = (obj.points.geometry as THREE.BufferGeometry).userData.sampleW as number;
            const sh = (obj.points.geometry as THREE.BufferGeometry).userData.sampleH as number;
            updatePointCloud(obj.video, obj.points.geometry, sw, sh);
          }
        }
      }

      if (isStereo) {
        const w = container.clientWidth;
        const h = container.clientHeight;
        ref.renderer.setViewport(0, 0, w / 2, h);
        ref.renderer.setScissor(0, 0, w / 2, h);
        ref.camera.position.x -= 0.08;
        ref.renderer.render(ref.scene, ref.camera);
        ref.camera.position.x += 0.16;
        ref.renderer.setViewport(w / 2, 0, w / 2, h);
        ref.renderer.setScissor(w / 2, 0, w / 2, h);
        ref.renderer.render(ref.scene, ref.camera);
        ref.camera.position.x -= 0.08;
      } else {
        ref.renderer.setViewport(0, 0, container.clientWidth, container.clientHeight);
        ref.renderer.setScissor(0, 0, container.clientWidth, container.clientHeight);
        ref.renderer.render(ref.scene, ref.camera);
      }

      ref.animationId = requestAnimationFrame(animate);
    };
    animate();

    const onResize = () => {
      if (!sceneRef.current) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      sceneRef.current.camera.aspect = w / h;
      sceneRef.current.camera.updateProjectionMatrix();
      sceneRef.current.renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(sceneRef.current?.animationId ?? 0);
      window.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('mousedown', onMouseDown);
      renderer.domElement.removeEventListener('mousemove', onMouseMove);
      renderer.domElement.removeEventListener('mouseup', onMouseUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      sceneRef.current?.streamObjects.forEach((o) => {
        o.video.srcObject = null;
      });
      renderer.dispose();
      container.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, [containerRef]);

  useEffect(() => {
    const ref = sceneRef.current;
    if (!ref) return;

    const effect = toRenderEffect(viewModeRef.current);
    const activeKeys = new Set<string>();

    for (const mapping of mappings) {
      if (!mapping.visible) continue;
      const key = `${mapping.deviceId}:${mapping.streamType}`;
      activeKeys.add(key);

      const remote = remoteStreams.get(key);
      if (!remote) continue;

      let obj = ref.streamObjects.get(key);
      if (!obj) {
        const video = document.createElement('video');
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        obj = { video, effect };
        ref.streamObjects.set(key, obj);
      }

      if (obj.video.srcObject !== remote.stream) {
        obj.video.srcObject = remote.stream;
        obj.video.play().catch(() => {});
      }

      const displayObject = getStreamDisplayObject(obj);
      if (!displayObject || obj.effect !== effect) {
        rebuildStreamDisplay(ref, obj, remote, mapping, effect);
      } else {
        updateStreamTransform(displayObject, mapping);
      }
    }

    for (const [key, obj] of ref.streamObjects) {
      if (!activeKeys.has(key)) {
        if (obj.mesh) ref.scene.remove(obj.mesh);
        if (obj.points) ref.scene.remove(obj.points);
        disposeStreamDisplay(obj);
        obj.video.srcObject = null;
        ref.streamObjects.delete(key);
      }
    }
  }, [mappings, remoteStreams]);

  useEffect(() => {
    const ref = sceneRef.current;
    if (!ref) return;

    const effect = toRenderEffect(viewMode);
    for (const mapping of mappingsRef.current) {
      if (!mapping.visible) continue;
      const key = `${mapping.deviceId}:${mapping.streamType}`;
      const obj = ref.streamObjects.get(key);
      const remote = remoteStreamsRef.current.get(key);
      if (!obj || !remote) continue;
      const displayObject = getStreamDisplayObject(obj);
      if (!displayObject || obj.effect !== effect) {
        rebuildStreamDisplay(ref, obj, remote, mapping, effect);
      } else {
        updateStreamTransform(displayObject, mapping);
      }
    }
  }, [viewMode]);

  useEffect(() => {
    if (!backgroundStream || !sceneRef.current) return;
    const video = document.createElement('video');
    video.srcObject = backgroundStream;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.play();
    const tex = new THREE.VideoTexture(video);
    configureVideoTexture(tex);
    sceneRef.current.scene.background = tex;
    return () => {
      video.srcObject = null;
      tex.dispose();
      if (sceneRef.current) sceneRef.current.scene.background = new THREE.Color(0x0a0e17);
    };
  }, [backgroundStream]);
}
