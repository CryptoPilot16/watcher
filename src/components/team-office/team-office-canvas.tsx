'use client';

import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, Float, OrbitControls, RoundedBox, useAnimations, useFBX, useGLTF } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { SkeletonUtils, type OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { topicDisplayLabel, type TeamTaskSource, type TeamTopic } from '@/lib/watch-team';
import {
  loadOfficeLocalAssetManifest,
  OfficeAssetSlot,
  preloadOfficeAssets,
  resolveOfficeAssetManifest,
  withOfficePrivateAssetPath,
  OFFICE_PRIVATE_ASSET_ROOT,
  type OfficeAssetManifestOverride,
} from './office-asset-pipeline';

function statusColor(status: TeamTopic['live']['status']) {
  switch (status) {
    case 'running':
      return '#58d9ff';
    case 'recent':
      return '#f7c763';
    case 'idle':
      return '#9e8967';
    case 'missing':
      return '#ff6b6b';
    default:
      return '#d8ba75';
  }
}

function statusGlow(status: TeamTopic['live']['status']) {
  switch (status) {
    case 'running':
      return 1.9;
    case 'recent':
      return 1.22;
    case 'idle':
      return 0.35;
    case 'missing':
      return 0.9;
    default:
      return 0.45;
  }
}

function sourceLabel(source: TeamTaskSource) {
  switch (source) {
    case 'plan':
      return 'planning';
    case 'yield':
      return 'handoff';
    case 'user':
      return 'new task';
    case 'assistant':
      return 'replying';
    case 'tool':
      return 'tooling';
    default:
      return 'waiting';
  }
}

function actionLabel(topic: TeamTopic) {
  if (topic.live.status === 'running') return sourceLabel(topic.currentTask.source);
  if (topic.live.status === 'recent') return 'delivering';
  if (topic.live.status === 'missing') return 'offline';
  return 'in line';
}

function topicHeadline(topic: TeamTopic) {
  return topic.currentTask.snippet || topic.recent.lastAssistantText || topic.recent.lastUserText || topic.live.freshnessLabel || 'Waiting for work';
}

function hashLabel(label: string) {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return hash;
}

const WORKER_AVATAR_MANIFEST_URL = `${OFFICE_PRIVATE_ASSET_ROOT}/avatar-rig.manifest.local.json`;

type WorkerMode = 'desk' | 'delivery' | 'standby';
type WorkerAvatarClip = 'Typing' | 'Standing' | 'Presenting';

type WorkerAvatarAssetEntry = {
  url: string;
  scale?: number | [number, number, number];
  position?: [number, number, number];
  rotation?: [number, number, number];
};

type WorkerAvatarManifest = {
  model?: WorkerAvatarAssetEntry;
  animations: Partial<Record<WorkerAvatarClip, WorkerAvatarAssetEntry>>;
  stateMap: Record<WorkerMode, WorkerAvatarClip>;
};

function clipForWorkerMode(mode: WorkerMode): WorkerAvatarClip {
  if (mode === 'desk') return 'Typing';
  if (mode === 'delivery') return 'Presenting';
  return 'Standing';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asVector3(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  if (!value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return undefined;
  return value as [number, number, number];
}

function asScale(value: unknown): number | [number, number, number] | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return asVector3(value);
}

function toWorkerAvatarAssetEntry(value: unknown): WorkerAvatarAssetEntry | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return { url: withOfficePrivateAssetPath(value.trim()) };
  }

  if (!isRecord(value)) return null;

  const file = typeof value.file === 'string' ? value.file.trim() : '';
  const explicitUrl = typeof value.url === 'string' ? value.url.trim() : '';
  const url = explicitUrl || (file ? withOfficePrivateAssetPath(file) : '');
  if (!url) return null;

  const entry: WorkerAvatarAssetEntry = { url };
  const position = asVector3(value.position);
  const rotation = asVector3(value.rotation);
  const scale = asScale(value.scale);

  if (position) entry.position = position;
  if (rotation) entry.rotation = rotation;
  if (scale !== undefined) entry.scale = scale;

  return entry;
}

function parseWorkerAvatarLocalManifest(value: unknown): WorkerAvatarManifest | null {
  if (!isRecord(value)) return null;

  const model = toWorkerAvatarAssetEntry(value.model);
  const animationsBlock = isRecord(value.animations) ? value.animations : {};
  const animations: Partial<Record<WorkerAvatarClip, WorkerAvatarAssetEntry>> = {};

  (['Typing', 'Standing', 'Presenting'] as WorkerAvatarClip[]).forEach((clip) => {
    const entry = toWorkerAvatarAssetEntry(animationsBlock[clip]);
    if (entry) animations[clip] = entry;
  });

  const stateMapBlock = isRecord(value.stateMap) ? value.stateMap : {};
  const stateMap: Record<WorkerMode, WorkerAvatarClip> = {
    desk: stateMapBlock.desk === 'Standing' || stateMapBlock.desk === 'Presenting' ? stateMapBlock.desk : 'Typing',
    standby: stateMapBlock.standby === 'Typing' || stateMapBlock.standby === 'Presenting' ? stateMapBlock.standby : 'Standing',
    delivery: stateMapBlock.delivery === 'Typing' || stateMapBlock.delivery === 'Standing' ? stateMapBlock.delivery : 'Presenting',
  };

  if (!model) return null;
  return { model, animations, stateMap };
}

async function loadWorkerAvatarLocalManifest(signal?: AbortSignal): Promise<WorkerAvatarManifest | null> {
  try {
    const response = await fetch(WORKER_AVATAR_MANIFEST_URL, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) return null;
    return parseWorkerAvatarLocalManifest((await response.json()) as unknown);
  } catch {
    return null;
  }
}

function hasWorkerAvatarManifest(manifest?: WorkerAvatarManifest | null): manifest is WorkerAvatarManifest {
  return Boolean(manifest?.model && manifest.animations.Typing && manifest.animations.Standing && manifest.animations.Presenting);
}

function preloadWorkerAvatarAssets(manifest?: WorkerAvatarManifest | null) {
  if (!hasWorkerAvatarManifest(manifest)) return;
  useGLTF.preload(manifest.model.url);
  useFBX.preload(manifest.animations.Typing.url);
  useFBX.preload(manifest.animations.Standing.url);
  useFBX.preload(manifest.animations.Presenting.url);
}

type WorkerAvatarAssetBoundaryProps = {
  fallback: ReactNode;
  children: ReactNode;
};

type WorkerAvatarAssetBoundaryState = {
  hasError: boolean;
};

class WorkerAvatarAssetBoundary extends Component<WorkerAvatarAssetBoundaryProps, WorkerAvatarAssetBoundaryState> {
  state: WorkerAvatarAssetBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch() {}

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function WorkerAvatarModel({ clip, manifest }: { clip: WorkerAvatarClip; manifest: WorkerAvatarManifest }) {
  const group = useRef<THREE.Group>(null);
  const gltf = useGLTF(manifest.model!.url);
  const typingSource = useFBX(manifest.animations.Typing!.url) as THREE.Group & { animations: THREE.AnimationClip[] };
  const standingSource = useFBX(manifest.animations.Standing!.url) as THREE.Group & { animations: THREE.AnimationClip[] };
  const presentingSource = useFBX(manifest.animations.Presenting!.url) as THREE.Group & { animations: THREE.AnimationClip[] };

  const scene = useMemo(() => {
    const clone = SkeletonUtils.clone(gltf.scene) as THREE.Group;
    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return clone;
  }, [gltf.scene]);

  const clips = useMemo(() => {
    const namedClips: THREE.AnimationClip[] = [];
    const typing = typingSource.animations?.[0];
    const standing = standingSource.animations?.[0];
    const presenting = presentingSource.animations?.[0];

    if (typing) {
      const next = typing.clone();
      next.name = 'Typing';
      namedClips.push(next);
    }
    if (standing) {
      const next = standing.clone();
      next.name = 'Standing';
      namedClips.push(next);
    }
    if (presenting) {
      const next = presenting.clone();
      next.name = 'Presenting';
      namedClips.push(next);
    }

    return namedClips;
  }, [typingSource.animations, standingSource.animations, presentingSource.animations]);

  const { actions } = useAnimations(clips, group);

  useEffect(() => {
    const action = actions[clip] ?? actions.Standing ?? Object.values(actions)[0];
    if (!action) return;
    action.reset().fadeIn(0.35).play();
    return () => {
      action.fadeOut(0.25);
    };
  }, [actions, clip]);

  return (
    <group
      ref={group}
      position={manifest.model?.position ?? [0, -1.02, 0.03]}
      rotation={manifest.model?.rotation ?? [0, Math.PI, 0]}
      scale={manifest.model?.scale ?? 0.98}
    >
      <primitive object={scene} />
    </group>
  );
}

function paletteForTopic(topic: TeamTopic) {
  const seed = hashLabel(topicDisplayLabel(topic));
  const skin = ['#f5d9c4', '#e7bf9f', '#ca9a76', '#8c5b42'][seed % 4];
  const hair = ['#201915', '#4b3428', '#2a2f39', '#6a5948', '#e7e2d8'][(seed >> 2) % 5];
  const top = ['#243447', '#5c6b5d', '#7b4d46', '#4b5874', '#8a6b3f', '#3f5f64', '#5f4e63'][(seed >> 4) % 7];
  const bottom = ['#2b3038', '#3a414c', '#444d5c', '#323843', '#585f6b'][(seed >> 6) % 5];
  return { skin, hair, top, bottom };
}

type WorkerStyle = {
  bodyScale: [number, number, number];
  headScale: [number, number, number];
  shoulderWidth: number;
  legHeight: number;
  armLength: number;
  hasHat: boolean;
  hatColor: string;
  hatBrimColor: string;
  hasApron: boolean;
  apronColor: string;
  hasJacket: boolean;
  jacketColor: string;
  skirt: boolean;
  accentStripe: boolean;
  hasVest: boolean;
  vestColor: string;
  hasTie: boolean;
  tieColor: string;
  blouseColor: string;
  sockColor: string;
  shoeColor: string;
  hairStyle: 'bob' | 'part' | 'bun' | 'crop' | 'flip';
  hairVolume: number;
};

function styleForTopic(topic: TeamTopic): WorkerStyle {
  const seed = hashLabel(topicDisplayLabel(topic));
  const archetype = seed % 7;
  return {
    bodyScale: archetype === 4 ? [1.02, 1.06, 0.96] : archetype === 5 ? [0.96, 1.01, 0.92] : archetype === 1 ? [0.98, 1.03, 0.94] : [1, 1.04, 0.95],
    headScale: archetype === 0 ? [1.16, 1.1, 1.06] : archetype === 3 ? [1.12, 1.06, 1.03] : [1.1, 1.04, 1.02],
    shoulderWidth: archetype === 5 ? 0.118 : archetype === 4 ? 0.138 : 0.128,
    legHeight: archetype === 5 ? 0.2 : 0.225,
    armLength: archetype === 4 ? 0.23 : 0.21,
    hasHat: false,
    hatColor: '#2f3340',
    hatBrimColor: '#151515',
    hasApron: false,
    apronColor: '#f3f0ea',
    hasJacket: archetype === 2 || archetype === 3 || archetype === 6,
    jacketColor: ['#43546c', '#5a5f54', '#e4dfd6', '#64738d', '#73634b', '#575b63', '#32424d'][archetype],
    skirt: archetype === 5,
    accentStripe: archetype === 0 || archetype === 4,
    hasVest: archetype === 1 || archetype === 4,
    vestColor: ['#3f4c64', '#5d5148', '#495851', '#55647f', '#796048', '#5d5657', '#524c69'][archetype],
    hasTie: archetype === 0 || archetype === 2,
    tieColor: archetype === 0 ? '#c05a4f' : '#4d6b91',
    blouseColor: ['#efe6da', '#f1ebe1', '#f5f0e8', '#ebe5de', '#efe7db', '#f4eee7', '#e9e0d4'][archetype],
    sockColor: archetype === 5 ? '#ddd3c7' : '#616978',
    shoeColor: ['#332c28', '#34303a', '#262d38', '#453830', '#362d27', '#423431', '#2f3140'][archetype],
    hairStyle: ['part', 'crop', 'bob', 'part', 'crop', 'bun', 'bob'][archetype] as WorkerStyle['hairStyle'],
    hairVolume: archetype === 5 ? 1.04 : 0.96,
  };
}

type DeskLayout = {
  topic: TeamTopic;
  position: [number, number, number];
  rotationY: number;
  workerDeskPosition: [number, number, number];
  standbyPosition: [number, number, number];
  deliveryPosition: [number, number, number];
  focusPoint: [number, number, number];
};

type CameraMode = 'overview' | 'focus' | 'free';

function buildNameTexture(name: string, accent: string) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 220;
  canvas.height = 52;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(10, 10, 14, 0.72)';
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1.25;

  const x = 4;
  const y = 4;
  const w = canvas.width - 8;
  const h = canvas.height - 8;
  const radius = 10;

  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = accent;
  ctx.fillRect(11, 10, 6, h - 12);

  ctx.font = '600 18px JetBrains Mono, monospace';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f7f3eb';
  ctx.fillText(name, 24, canvas.height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function FloatingNameTag({ name, color, position, visible = true }: { name: string; color: string; position: [number, number, number]; visible?: boolean }) {
  const texture = useMemo(() => buildNameTexture(name, color), [name, color]);
  if (!texture || !visible) return null;

  return (
    <sprite position={position} scale={[1.24, 0.3, 1]} renderOrder={20}>
      <spriteMaterial map={texture} transparent depthWrite={false} depthTest={false} />
    </sprite>
  );
}

function ActivityDiamond({ visible }: { visible: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!mesh.current || !visible) return;
    const t = clock.getElapsedTime();
    mesh.current.rotation.y = t * 1.35;
  });

  if (!visible) return null;

  return (
    <Float speed={2.1} rotationIntensity={0.18} floatIntensity={0.55}>
      <mesh ref={mesh} position={[0, 1.58, 0]} castShadow>
        <octahedronGeometry args={[0.16, 0]} />
        <meshStandardMaterial color="#7dffad" emissive="#7dffad" emissiveIntensity={1.7} />
      </mesh>
    </Float>
  );
}

function AvatarHair({ palette, style }: { palette: ReturnType<typeof paletteForTopic>; style: WorkerStyle }) {
  const capScale: [number, number, number] = [style.headScale[0] * 1.03, style.headScale[1] * 0.74 * style.hairVolume, style.headScale[2] * 0.98];

  return (
    <group>
      <mesh castShadow position={[0, 0.935, -0.03]} scale={capScale}>
        <sphereGeometry args={[0.125, 20, 20, 0, Math.PI * 2, 0, Math.PI / 1.9]} />
        <meshStandardMaterial color={palette.hair} roughness={0.76} />
      </mesh>

      {style.hairStyle === 'part' && (
        <>
          <mesh castShadow position={[0, 0.9, 0.03]} rotation={[0.2, 0, 0]}>
            <boxGeometry args={[0.16, 0.024, 0.048]} />
            <meshStandardMaterial color={palette.hair} roughness={0.74} />
          </mesh>
          <mesh castShadow position={[-0.055, 0.855, 0.026]} rotation={[0.16, 0.18, -0.12]}>
            <boxGeometry args={[0.06, 0.09, 0.028]} />
            <meshStandardMaterial color={palette.hair} roughness={0.74} />
          </mesh>
        </>
      )}

      {style.hairStyle === 'crop' && (
        <mesh castShadow position={[0, 0.912, 0.026]} rotation={[0.3, 0, 0]}>
          <boxGeometry args={[0.17, 0.03, 0.06]} />
          <meshStandardMaterial color={palette.hair} roughness={0.7} />
        </mesh>
      )}

      {style.hairStyle === 'bob' && (
        <>
          <mesh castShadow position={[0, 0.85, -0.04]} scale={[1, 0.88, 0.9]}>
            <sphereGeometry args={[0.105, 16, 16, 0, Math.PI * 2, Math.PI / 2.3, Math.PI / 1.72]} />
            <meshStandardMaterial color={palette.hair} roughness={0.78} />
          </mesh>
          {[-0.092, 0.092].map((x) => (
            <mesh key={`bob-side-${x}`} castShadow position={[x, 0.84, -0.006]} scale={[0.82, 1.1, 0.74]}>
              <sphereGeometry args={[0.036, 12, 12]} />
              <meshStandardMaterial color={palette.hair} roughness={0.78} />
            </mesh>
          ))}
        </>
      )}

      {style.hairStyle === 'bun' && (
        <>
          <mesh castShadow position={[0, 0.82, -0.09]}>
            <sphereGeometry args={[0.05, 12, 12]} />
            <meshStandardMaterial color={palette.hair} roughness={0.78} />
          </mesh>
          <mesh castShadow position={[0, 0.882, 0.016]} rotation={[0.24, 0, 0]}>
            <boxGeometry args={[0.145, 0.026, 0.04]} />
            <meshStandardMaterial color={palette.hair} roughness={0.74} />
          </mesh>
        </>
      )}
    </group>
  );
}

function PrimitiveWorkerAvatar({ topic, standbyPosition, deskPosition, deliveryPosition, deskFacing, reducedMotion, seed, emphasized, onHover, onLeave, onSelect }: {
  topic: TeamTopic;
  standbyPosition: [number, number, number];
  deskPosition: [number, number, number];
  deliveryPosition: [number, number, number];
  deskFacing: number;
  reducedMotion: boolean;
  seed: number;
  emphasized: boolean;
  onHover: () => void;
  onLeave: () => void;
  onSelect: () => void;
}) {
  const group = useRef<THREE.Group>(null);
  const torso = useRef<THREE.Group>(null);
  const leftUpperArm = useRef<THREE.Group>(null);
  const rightUpperArm = useRef<THREE.Group>(null);
  const leftForearm = useRef<THREE.Group>(null);
  const rightForearm = useRef<THREE.Group>(null);
  const leftThigh = useRef<THREE.Group>(null);
  const rightThigh = useRef<THREE.Group>(null);
  const leftShin = useRef<THREE.Group>(null);
  const rightShin = useRef<THREE.Group>(null);
  const chest = useRef<THREE.Mesh>(null);
  const palette = useMemo(() => paletteForTopic(topic), [topic]);
  const style = useMemo(() => styleForTopic(topic), [topic]);
  const accent = useMemo(() => new THREE.Color(statusColor(topic.live.status)), [topic.live.status]);
  const mode: WorkerMode = topic.live.status === 'running' ? 'desk' : topic.live.status === 'recent' ? 'delivery' : 'standby';

  useFrame(({ clock }) => {
    if (!group.current) return;

    const t = clock.getElapsedTime() + seed * 0.27;
    const motion = reducedMotion ? 0 : Math.sin(t * 2.0) * 0.013;
    const anchor = mode === 'desk' ? deskPosition : mode === 'delivery' ? deliveryPosition : standbyPosition;
    const facing = mode === 'desk' ? deskFacing : 0;
    const typing = Math.sin(t * 7.6) * 0.08;

    group.current.position.set(anchor[0], 0.045 + motion, anchor[2]);
    group.current.rotation.set(0, facing, 0);

    if (torso.current) {
      if (mode === 'desk') {
        torso.current.rotation.x = 0.16;
        torso.current.position.y = 0.56;
      } else if (mode === 'delivery') {
        torso.current.rotation.x = -0.04;
        torso.current.position.y = 0.58;
      } else {
        torso.current.rotation.x = reducedMotion ? 0 : Math.sin(t * 1.45) * 0.03;
        torso.current.position.y = 0.57;
      }
    }

    if (leftUpperArm.current && rightUpperArm.current && leftForearm.current && rightForearm.current) {
      if (mode === 'desk') {
        leftUpperArm.current.rotation.x = -0.88 + typing;
        rightUpperArm.current.rotation.x = -0.76 - typing;
        leftForearm.current.rotation.x = -0.72 + typing * 0.55;
        rightForearm.current.rotation.x = -0.78 - typing * 0.55;
      } else if (mode === 'delivery') {
        leftUpperArm.current.rotation.x = -0.24;
        rightUpperArm.current.rotation.x = -0.58;
        leftForearm.current.rotation.x = -0.22;
        rightForearm.current.rotation.x = -0.48;
      } else {
        leftUpperArm.current.rotation.x = -0.36;
        rightUpperArm.current.rotation.x = -0.31;
        leftForearm.current.rotation.x = -0.14;
        rightForearm.current.rotation.x = -0.1;
      }
    }

    if (leftThigh.current && rightThigh.current && leftShin.current && rightShin.current) {
      if (mode === 'desk') {
        leftThigh.current.rotation.x = -1.38;
        rightThigh.current.rotation.x = -1.38;
        leftShin.current.rotation.x = 1.44;
        rightShin.current.rotation.x = 1.44;
      } else if (mode === 'delivery') {
        leftThigh.current.rotation.x = 0.04;
        rightThigh.current.rotation.x = -0.02;
        leftShin.current.rotation.x = 0;
        rightShin.current.rotation.x = 0;
      } else {
        leftThigh.current.rotation.x = 0;
        rightThigh.current.rotation.x = 0;
        leftShin.current.rotation.x = 0;
        rightShin.current.rotation.x = 0;
      }
    }

    if (chest.current) {
      (chest.current.material as THREE.MeshStandardMaterial).emissiveIntensity = topic.live.status === 'running' ? 0.12 : 0.02;
    }
  });

  if (topic.live.status === 'missing') {
    return (
      <group position={[standbyPosition[0], 0.1, standbyPosition[2]]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.09, 0.14, 18]} />
          <meshBasicMaterial color="#7f8791" transparent opacity={0.38} />
        </mesh>
        <mesh position={[0, 0.08, 0]}>
          <cylinderGeometry args={[0.04, 0.05, 0.14, 12]} />
          <meshStandardMaterial color="#8d96a1" emissive="#d8dde4" emissiveIntensity={0.08} />
        </mesh>
      </group>
    );
  }

  return (
    <group ref={group}>
      <mesh position={[0, 0.04, 0.02]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.13, 0.17, 18]} />
        <meshBasicMaterial color={accent} transparent opacity={topic.live.status === 'running' ? 0.48 : 0.2} />
      </mesh>

      <group scale={style.bodyScale}>
        <group ref={torso} position={[0, 0.57, 0.02]}>
          <mesh castShadow position={[0, 0.12, 0.01]}>
            <capsuleGeometry args={[0.128, 0.14, 6, 12]} />
            <meshStandardMaterial color={style.blouseColor} roughness={0.9} />
          </mesh>
          <mesh ref={chest} castShadow position={[0, -0.02, 0.02]}>
            <capsuleGeometry args={[0.138, 0.24, 8, 14]} />
            <meshStandardMaterial color={palette.top} roughness={0.82} emissive={accent} emissiveIntensity={topic.live.status === 'running' ? 0.12 : 0.02} />
          </mesh>
          <mesh castShadow position={[0, -0.2, 0.04]}>
            <capsuleGeometry args={[0.112, 0.1, 6, 10]} />
            <meshStandardMaterial color={palette.bottom} roughness={0.88} />
          </mesh>
          {style.hasVest && (
            <mesh castShadow position={[0, -0.02, 0.09]}>
              <capsuleGeometry args={[0.122, 0.2, 8, 12]} />
              <meshStandardMaterial color={style.vestColor} roughness={0.84} />
            </mesh>
          )}
          {style.hasJacket && (
            <mesh castShadow position={[0, -0.01, 0.07]}>
              <capsuleGeometry args={[0.15, 0.28, 8, 14]} />
              <meshStandardMaterial color={style.jacketColor} roughness={0.86} />
            </mesh>
          )}
          {style.accentStripe && (
            <mesh castShadow position={[0, -0.02, 0.17]}>
              <boxGeometry args={[0.042, 0.22, 0.02]} />
              <meshStandardMaterial color="#f4ecdf" roughness={0.7} />
            </mesh>
          )}
          {style.hasTie && (
            <>
              <mesh castShadow position={[0, 0.1, 0.17]} rotation={[0, 0, Math.PI / 4]}>
                <boxGeometry args={[0.034, 0.034, 0.018]} />
                <meshStandardMaterial color={style.tieColor} roughness={0.75} />
              </mesh>
              <mesh castShadow position={[0, -0.02, 0.17]}>
                <boxGeometry args={[0.028, 0.16, 0.018]} />
                <meshStandardMaterial color={style.tieColor} roughness={0.75} />
              </mesh>
            </>
          )}
        </group>

        {style.skirt && (
          <mesh castShadow position={[0, 0.34, 0.05]}>
            <cylinderGeometry args={[0.1, 0.17, 0.22, 12]} />
            <meshStandardMaterial color={palette.bottom} roughness={0.9} />
          </mesh>
        )}

        <mesh castShadow position={[0, 0.73, 0.02]}>
          <capsuleGeometry args={[0.03, 0.038, 4, 8]} />
          <meshStandardMaterial color={palette.skin} roughness={0.92} />
        </mesh>
        <mesh castShadow position={[0, 0.88, -0.01]} scale={style.headScale}>
          <sphereGeometry args={[0.13, 24, 24]} />
          <meshStandardMaterial color={palette.skin} roughness={0.94} />
        </mesh>
        <AvatarHair palette={palette} style={style} />
        {[-0.043, 0.043].map((x) => (
          <mesh key={`eye-${x}`} castShadow position={[x, 0.88, 0.122]}>
            <sphereGeometry args={[0.011, 12, 12]} />
            <meshStandardMaterial color="#2b241f" roughness={0.35} />
          </mesh>
        ))}
        {[-0.118, 0.118].map((x) => (
          <mesh key={`ear-${x}`} castShadow position={[x, 0.85, 0.004]} scale={[0.76, 1.05, 0.72]}>
            <sphereGeometry args={[0.022, 10, 10]} />
            <meshStandardMaterial color={palette.skin} roughness={0.96} />
          </mesh>
        ))}
        <mesh castShadow position={[0, 0.833, 0.118]} scale={[0.66, 1, 0.86]}>
          <sphereGeometry args={[0.01, 10, 10]} />
          <meshStandardMaterial color="#cf9d83" roughness={0.92} />
        </mesh>
        <mesh castShadow position={[0, 0.792, 0.118]}>
          <boxGeometry args={[0.04, 0.006, 0.006]} />
          <meshStandardMaterial color="#b36e71" roughness={0.84} />
        </mesh>

        <group ref={leftUpperArm} position={[-style.shoulderWidth, 0.64, 0.03]}>
          <mesh castShadow position={[0, -0.1, 0]}>
            <capsuleGeometry args={[0.036, 0.16, 4, 10]} />
            <meshStandardMaterial color={style.hasVest ? style.vestColor : palette.top} roughness={0.86} />
          </mesh>
          <group ref={leftForearm} position={[0, -0.21, 0]}>
            <mesh castShadow position={[0, -0.095, 0]}>
              <capsuleGeometry args={[0.032, 0.14, 4, 10]} />
              <meshStandardMaterial color={style.blouseColor} roughness={0.88} />
            </mesh>
            <mesh castShadow position={[0, -0.2, 0.01]}>
              <sphereGeometry args={[0.042, 12, 12]} />
              <meshStandardMaterial color={palette.skin} roughness={0.94} />
            </mesh>
          </group>
        </group>
        <group ref={rightUpperArm} position={[style.shoulderWidth, 0.64, 0.03]}>
          <mesh castShadow position={[0, -0.1, 0]}>
            <capsuleGeometry args={[0.036, 0.16, 4, 10]} />
            <meshStandardMaterial color={style.hasVest ? style.vestColor : palette.top} roughness={0.86} />
          </mesh>
          <group ref={rightForearm} position={[0, -0.21, 0]}>
            <mesh castShadow position={[0, -0.095, 0]}>
              <capsuleGeometry args={[0.032, 0.14, 4, 10]} />
              <meshStandardMaterial color={style.blouseColor} roughness={0.88} />
            </mesh>
            <mesh castShadow position={[0, -0.2, 0.01]}>
              <sphereGeometry args={[0.042, 12, 12]} />
              <meshStandardMaterial color={palette.skin} roughness={0.94} />
            </mesh>
          </group>
        </group>

        <group ref={leftThigh} position={[-0.075, 0.34, 0.05]}>
          <mesh castShadow position={[0, -0.11, 0]}>
            <capsuleGeometry args={[0.044, 0.18, 4, 10]} />
            <meshStandardMaterial color={style.skirt ? style.sockColor : palette.bottom} roughness={0.9} />
          </mesh>
          <group ref={leftShin} position={[0, -0.21, 0.02]}>
            <mesh castShadow position={[0, -0.11, 0]}>
              <capsuleGeometry args={[0.038, 0.17, 4, 10]} />
              <meshStandardMaterial color={style.skirt ? style.sockColor : palette.bottom} roughness={0.92} />
            </mesh>
            <RoundedBox args={[0.11, 0.05, 0.18]} radius={0.018} smoothness={3} position={[0, -0.22, 0.05]} castShadow>
              <meshStandardMaterial color={style.shoeColor} roughness={0.78} />
            </RoundedBox>
          </group>
        </group>
        <group ref={rightThigh} position={[0.075, 0.34, 0.05]}>
          <mesh castShadow position={[0, -0.11, 0]}>
            <capsuleGeometry args={[0.044, 0.18, 4, 10]} />
            <meshStandardMaterial color={style.skirt ? style.sockColor : palette.bottom} roughness={0.9} />
          </mesh>
          <group ref={rightShin} position={[0, -0.21, 0.02]}>
            <mesh castShadow position={[0, -0.11, 0]}>
              <capsuleGeometry args={[0.038, 0.17, 4, 10]} />
              <meshStandardMaterial color={style.skirt ? style.sockColor : palette.bottom} roughness={0.92} />
            </mesh>
            <RoundedBox args={[0.11, 0.05, 0.18]} radius={0.018} smoothness={3} position={[0, -0.22, 0.05]} castShadow>
              <meshStandardMaterial color={style.shoeColor} roughness={0.78} />
            </RoundedBox>
          </group>
        </group>
      </group>

      <ActivityDiamond visible={emphasized || topic.live.status === 'running'} />
      <FloatingNameTag name={topicDisplayLabel(topic)} color={statusColor(topic.live.status)} position={[0.18, 1.72, 0.02]} visible={emphasized || topic.live.status === 'running' || topic.live.status === 'recent'} />

      <mesh
        position={[0, 0.7, 0]}
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover();
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          onLeave();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        <capsuleGeometry args={[0.24, 0.96, 6, 12]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </group>
  );
}

function WorkerAvatar(props: {
  topic: TeamTopic;
  standbyPosition: [number, number, number];
  deskPosition: [number, number, number];
  deliveryPosition: [number, number, number];
  deskFacing: number;
  reducedMotion: boolean;
  seed: number;
  emphasized: boolean;
  onHover: () => void;
  onLeave: () => void;
  onSelect: () => void;
  manifest?: WorkerAvatarManifest | null;
}) {
  const mode: WorkerMode = props.topic.live.status === 'running' ? 'desk' : props.topic.live.status === 'recent' ? 'delivery' : 'standby';
  const avatarClip = props.manifest?.stateMap[mode] ?? clipForWorkerMode(mode);
  const anchor = mode === 'desk' ? props.deskPosition : mode === 'delivery' ? props.deliveryPosition : props.standbyPosition;
  const facing = mode === 'desk' ? props.deskFacing : 0;
  const fallback = <PrimitiveWorkerAvatar {...props} />;

  if (props.topic.live.status === 'missing' || !hasWorkerAvatarManifest(props.manifest)) {
    return fallback;
  }

  const key = `${props.manifest.model!.url}:${props.manifest.animations.Typing!.url}:${props.manifest.animations.Standing!.url}:${props.manifest.animations.Presenting!.url}`;

  return (
    <WorkerAvatarAssetBoundary key={key} fallback={fallback}>
      <Suspense fallback={fallback}>
        <group position={[anchor[0], 0.09, anchor[2]]} rotation={[0, facing, 0]}>
          <mesh position={[0, 0.05, 0.02]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.13, 0.17, 18]} />
            <meshBasicMaterial color={statusColor(props.topic.live.status)} transparent opacity={props.topic.live.status === 'running' ? 0.48 : 0.2} />
          </mesh>
          <WorkerAvatarModel clip={avatarClip} manifest={props.manifest} />
          <ActivityDiamond visible={props.emphasized || props.topic.live.status === 'running'} />
          <FloatingNameTag name={topicDisplayLabel(props.topic)} color={statusColor(props.topic.live.status)} position={[0.18, 1.78, 0.02]} visible={props.emphasized || props.topic.live.status === 'running' || props.topic.live.status === 'recent'} />
          <mesh
            position={[0, 0.7, 0]}
            onPointerOver={(event) => {
              event.stopPropagation();
              props.onHover();
            }}
            onPointerOut={(event) => {
              event.stopPropagation();
              props.onLeave();
            }}
            onClick={(event) => {
              event.stopPropagation();
              props.onSelect();
            }}
          >
            <capsuleGeometry args={[0.22, 0.95, 6, 12]} />
            <meshBasicMaterial transparent opacity={0} />
          </mesh>
        </group>
      </Suspense>
    </WorkerAvatarAssetBoundary>
  );
}

function DeskFallback({ glow, glowStrength, reducedMotion, seed, emphasized }: {
  glow: THREE.Color;
  glowStrength: number;
  reducedMotion: boolean;
  seed: number;
  emphasized: boolean;
}) {
  const monitor = useRef<THREE.Mesh>(null);
  const lamp = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (reducedMotion) return;
    const t = clock.getElapsedTime() + seed * 0.22;
    if (monitor.current) monitor.current.rotation.z = Math.sin(t * 0.7) * 0.012;
    if (lamp.current) lamp.current.rotation.z = -0.22 + Math.sin(t * 2.2) * 0.03;
  });

  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <ringGeometry args={[0.6, emphasized ? 0.9 : 0.78, 32]} />
        <meshBasicMaterial color={glow} transparent opacity={emphasized ? 0.28 : 0.13} />
      </mesh>

      <RoundedBox args={[1.46, 0.09, 0.78]} radius={0.025} smoothness={4} position={[-0.06, 0.48, -0.08]} castShadow receiveShadow>
        <meshStandardMaterial color="#e3d7c5" roughness={0.86} />
      </RoundedBox>
      <RoundedBox args={[0.68, 0.09, 0.98]} radius={0.025} smoothness={4} position={[0.43, 0.48, 0.22]} castShadow receiveShadow>
        <meshStandardMaterial color="#ddd0bc" roughness={0.86} />
      </RoundedBox>
      {[
        [-0.72, 0.24, -0.37],
        [0.38, 0.24, -0.37],
        [-0.72, 0.24, 0.21],
        [0.13, 0.24, 0.67],
        [0.77, 0.24, 0.67],
      ].map((leg, i) => (
        <mesh key={i} position={leg as [number, number, number]} castShadow>
          <boxGeometry args={[0.08, 0.48, 0.08]} />
          <meshStandardMaterial color="#837768" />
        </mesh>
      ))}

      <mesh position={[-0.64, 0.26, 0.14]} castShadow>
        <boxGeometry args={[0.28, 0.44, 0.46]} />
        <meshStandardMaterial color="#c2b39f" />
      </mesh>
      {[0.15, 0.28, 0.41].map((y, i) => (
        <mesh key={`drawer-${i}`} position={[-0.51, y, 0.32]} castShadow>
          <boxGeometry args={[0.02, 0.08, 0.16]} />
          <meshStandardMaterial color="#7e7163" />
        </mesh>
      ))}

      <RoundedBox args={[0.46, 0.34, 0.36]} radius={0.015} smoothness={3} position={[-0.1, 0.82, -0.27]} castShadow ref={monitor as never}>
        <meshStandardMaterial color="#cdc7b9" roughness={0.62} />
      </RoundedBox>
      <mesh position={[-0.1, 0.84, -0.45]} castShadow>
        <boxGeometry args={[0.32, 0.2, 0.018]} />
        <meshStandardMaterial color="#9fc8d8" emissive={glow} emissiveIntensity={glowStrength * 0.48} />
      </mesh>
      <mesh position={[-0.1, 0.62, -0.24]} castShadow>
        <boxGeometry args={[0.08, 0.12, 0.08]} />
        <meshStandardMaterial color="#69645d" />
      </mesh>
      <mesh position={[-0.12, 0.54, -0.09]} castShadow>
        <boxGeometry args={[0.34, 0.03, 0.14]} />
        <meshStandardMaterial color="#d2c6b5" />
      </mesh>

      <RoundedBox args={[0.28, 0.24, 0.24]} radius={0.014} smoothness={3} position={[0.3, 0.75, -0.16]} castShadow>
        <meshStandardMaterial color="#c2bcaf" roughness={0.62} />
      </RoundedBox>
      <mesh position={[0.3, 0.76, -0.29]} castShadow>
        <boxGeometry args={[0.18, 0.12, 0.015]} />
        <meshStandardMaterial color="#8fb7ca" emissive={glow} emissiveIntensity={glowStrength * 0.22} />
      </mesh>
      <mesh position={[0.3, 0.62, -0.15]} castShadow>
        <boxGeometry args={[0.06, 0.1, 0.06]} />
        <meshStandardMaterial color="#6c665f" />
      </mesh>

      <mesh position={[0.58, 0.55, -0.08]} castShadow rotation={[0, 0, -0.28]} ref={lamp}>
        <boxGeometry args={[0.04, 0.34, 0.04]} />
        <meshStandardMaterial color="#57534d" emissive={glow} emissiveIntensity={glowStrength * 0.1} />
      </mesh>
      <mesh position={[0.66, 0.73, -0.15]} castShadow rotation={[0, 0, 0.22]}>
        <coneGeometry args={[0.1, 0.16, 4]} />
        <meshStandardMaterial color="#e8dfcf" emissive="#efe6d7" emissiveIntensity={0.18} />
      </mesh>
      <mesh position={[0.53, 0.49, -0.03]} castShadow>
        <cylinderGeometry args={[0.08, 0.08, 0.025, 14]} />
        <meshStandardMaterial color="#615950" />
      </mesh>

      <mesh position={[0.45, 0.55, 0.38]} castShadow>
        <boxGeometry args={[0.22, 0.04, 0.28]} />
        <meshStandardMaterial color="#c7b39a" />
      </mesh>
      <mesh position={[0.16, 0.55, 0.34]} castShadow>
        <boxGeometry args={[0.16, 0.04, 0.22]} />
        <meshStandardMaterial color="#cfbfab" />
      </mesh>
      <mesh position={[0.62, 0.54, 0.2]} castShadow>
        <boxGeometry args={[0.1, 0.08, 0.08]} />
        <meshStandardMaterial color="#6a6258" />
      </mesh>

      <RoundedBox args={[1.48, 0.5, 0.06]} radius={0.02} smoothness={4} position={[-0.06, 0.84, -0.47]} castShadow>
        <meshStandardMaterial color="#b8b6ac" />
      </RoundedBox>
      <mesh position={[-0.06, 0.86, -0.43]}>
        <boxGeometry args={[1.4, 0.32, 0.01]} />
        <meshStandardMaterial color="#95a8a0" />
      </mesh>
      <RoundedBox args={[0.06, 0.5, 1.02]} radius={0.02} smoothness={4} position={[0.8, 0.84, 0.1]} castShadow>
        <meshStandardMaterial color="#b8b6ac" />
      </RoundedBox>
      <mesh position={[0.76, 0.86, 0.1]} rotation={[0, Math.PI / 2, 0]}>
        <boxGeometry args={[1, 0.32, 0.01]} />
        <meshStandardMaterial color="#95a8a0" />
      </mesh>
    </>
  );
}

function ChairFallback({ glow, glowStrength }: { glow: THREE.Color; glowStrength: number }) {
  return (
    <>
      <mesh position={[0, 0.3, 0.03]} castShadow>
        <boxGeometry args={[0.44, 0.09, 0.42]} />
        <meshStandardMaterial color="#627387" emissive={glow} emissiveIntensity={glowStrength * 0.07} />
      </mesh>
      <mesh position={[0, 0.56, 0.2]} castShadow>
        <boxGeometry args={[0.44, 0.4, 0.1]} />
        <meshStandardMaterial color="#6f8197" />
      </mesh>
      <mesh position={[0, 0.79, 0.18]} castShadow>
        <boxGeometry args={[0.3, 0.12, 0.08]} />
        <meshStandardMaterial color="#7689a0" />
      </mesh>
      {[-0.18, 0.18].map((x, i) => (
        <mesh key={i} position={[x, 0.36, 0.06]} castShadow>
          <boxGeometry args={[0.06, 0.2, 0.26]} />
          <meshStandardMaterial color="#536274" />
        </mesh>
      ))}
      <mesh position={[0, 0.14, 0.02]} castShadow>
        <cylinderGeometry args={[0.045, 0.05, 0.28, 14]} />
        <meshStandardMaterial color="#5d574f" />
      </mesh>
      {[
        [-0.22, 0.05, 0.19],
        [0.22, 0.05, 0.19],
        [-0.24, 0.05, -0.13],
        [0.24, 0.05, -0.13],
        [0, 0.05, -0.23],
      ].map((leg, i) => (
        <mesh key={`leg-${i}`} position={leg as [number, number, number]} castShadow>
          <boxGeometry args={[0.13, 0.02, 0.04]} />
          <meshStandardMaterial color="#463f39" />
        </mesh>
      ))}
      {[
        [-0.24, 0.02, 0.19],
        [0.24, 0.02, 0.19],
        [-0.26, 0.02, -0.13],
        [0.26, 0.02, -0.13],
        [0, 0.02, -0.25],
      ].map((wheel, i) => (
        <mesh key={`wheel-${i}`} position={wheel as [number, number, number]} castShadow>
          <cylinderGeometry args={[0.03, 0.03, 0.035, 10]} />
          <meshStandardMaterial color="#1f2026" />
        </mesh>
      ))}
    </>
  );
}

function DeskUnit({ topic, position, rotationY, reducedMotion, seed, emphasized, manifest, onHover, onLeave, onSelect }: {
  topic: TeamTopic;
  position: [number, number, number];
  rotationY: number;
  reducedMotion: boolean;
  seed: number;
  emphasized: boolean;
  manifest?: OfficeAssetManifestOverride;
  onHover: () => void;
  onLeave: () => void;
  onSelect: () => void;
}) {
  const glow = useMemo(() => new THREE.Color(statusColor(topic.live.status)), [topic.live.status]);
  const glowStrength = statusGlow(topic.live.status);

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <OfficeAssetSlot slot="desk" manifest={manifest} fallback={<DeskFallback glow={glow} glowStrength={glowStrength} reducedMotion={reducedMotion} seed={seed} emphasized={emphasized} />} />

      <OfficeAssetSlot slot="deskChair" manifest={manifest} position={[0.08, 0.02, 0.58]} fallback={<ChairFallback glow={glow} glowStrength={glowStrength} />} />

      <mesh
        position={[0, 0.6, 0.17]}
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover();
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          onLeave();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        <boxGeometry args={[1.85, 1.65, 1.55]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </group>
  );
}

function RouteLine({ start, end, topic, reducedMotion }: {
  start: [number, number, number];
  end: [number, number, number];
  topic: TeamTopic;
  reducedMotion: boolean;
}) {
  const dot = useRef<THREE.Mesh>(null);
  const curve = useMemo(() => {
    const mid = new THREE.Vector3((start[0] + end[0]) / 2, 0.22, (start[2] + end[2]) / 2);
    return new THREE.QuadraticBezierCurve3(new THREE.Vector3(...start), mid, new THREE.Vector3(...end));
  }, [start, end]);
  const geometry = useMemo(() => new THREE.TubeGeometry(curve, 28, 0.025, 10, false), [curve]);
  const glow = useMemo(() => new THREE.Color(statusColor(topic.live.status)), [topic.live.status]);

  useFrame(({ clock }) => {
    if (reducedMotion || !dot.current || topic.live.status === 'missing') return;
    const t = clock.getElapsedTime();
    const p = topic.live.status === 'running' ? (t * 0.28) % 1 : (Math.sin(t * 1.1) + 1) / 2;
    const point = curve.getPoint(p);
    dot.current.position.set(point.x, point.y, point.z);
  });

  return (
    <>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          color={glow}
          emissive={glow}
          emissiveIntensity={topic.live.status === 'idle' ? 0.08 : 0.45}
          transparent
          opacity={topic.live.status === 'missing' ? 0.08 : 0.28}
        />
      </mesh>
      {topic.live.status !== 'missing' && (
        <mesh ref={dot}>
          <sphereGeometry args={[0.078, 14, 14]} />
          <meshStandardMaterial color={glow} emissive={glow} emissiveIntensity={1.3} />
        </mesh>
      )}
    </>
  );
}

function WallFrameFallback() {
  return (
    <>
      <RoundedBox args={[2.15, 2.18, 0.08]} radius={0.04} smoothness={4} castShadow>
        <meshStandardMaterial color="#25262c" roughness={0.72} />
      </RoundedBox>
      <mesh position={[0, 0, -0.03]}>
        <planeGeometry args={[1.82, 1.84]} />
        <meshStandardMaterial color="#deefff" emissive="#deefff" emissiveIntensity={0.2} />
      </mesh>
      <mesh position={[0, 0, 0.02]}>
        <boxGeometry args={[0.07, 1.85, 0.03]} />
        <meshStandardMaterial color="#25262c" />
      </mesh>
    </>
  );
}

function PlantFallback() {
  return (
    <>
      <mesh position={[0, 0.24, 0]} castShadow>
        <cylinderGeometry args={[0.23, 0.26, 0.42, 18]} />
        <meshStandardMaterial color="#d2a67d" roughness={0.82} />
      </mesh>
      <mesh position={[0, 0.62, 0]} castShadow>
        <icosahedronGeometry args={[0.34, 0]} />
        <meshStandardMaterial color="#81bf8f" roughness={0.74} />
      </mesh>
      <mesh position={[0.16, 0.75, 0.02]} castShadow>
        <icosahedronGeometry args={[0.2, 0]} />
        <meshStandardMaterial color="#74af80" roughness={0.74} />
      </mesh>
      <mesh position={[-0.14, 0.74, -0.02]} castShadow>
        <icosahedronGeometry args={[0.18, 0]} />
        <meshStandardMaterial color="#6fa67b" roughness={0.74} />
      </mesh>
    </>
  );
}

function CeilingLampFallback() {
  return (
    <>
      <mesh position={[0, 0.85, 0]}>
        <cylinderGeometry args={[0.01, 0.01, 1.7, 12]} />
        <meshStandardMaterial color="#8b8e99" />
      </mesh>
      <mesh position={[0, 0.08, 0]}>
        <cylinderGeometry args={[0.34, 0.24, 0.17, 22]} />
        <meshStandardMaterial color="#f4f5f9" emissive="#f4f5f9" emissiveIntensity={0.12} />
      </mesh>
      <pointLight position={[0, -0.08, 0]} intensity={1.8} distance={8} color="#fff4dd" />
    </>
  );
}

function CoffeeMachineFallback() {
  return (
    <>
      <RoundedBox args={[0.62, 0.9, 0.56]} radius={0.08} smoothness={4} position={[0, 0.45, 0]} castShadow>
        <meshStandardMaterial color="#f5f7fb" />
      </RoundedBox>
      <mesh position={[0, 0.86, -0.05]} castShadow>
        <boxGeometry args={[0.36, 0.16, 0.22]} />
        <meshStandardMaterial color="#11151e" emissive="#11151e" emissiveIntensity={0.12} />
      </mesh>
      <mesh position={[0, 0.36, 0.18]} castShadow>
        <boxGeometry args={[0.24, 0.18, 0.11]} />
        <meshStandardMaterial color="#dfe5ef" />
      </mesh>
    </>
  );
}

function SofaFallback() {
  return (
    <>
      <RoundedBox args={[1.96, 0.4, 0.86]} radius={0.08} smoothness={4} position={[0, 0.26, 0]} castShadow>
        <meshStandardMaterial color="#6f8dbc" />
      </RoundedBox>
      <RoundedBox args={[1.96, 0.44, 0.2]} radius={0.06} smoothness={4} position={[0, 0.66, -0.25]} castShadow>
        <meshStandardMaterial color="#5f80b3" />
      </RoundedBox>
    </>
  );
}

function SideTableFallback() {
  return (
    <>
      <mesh position={[0, 0.19, 0]} castShadow>
        <cylinderGeometry args={[0.26, 0.3, 0.38, 18]} />
        <meshStandardMaterial color="#d4a076" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.47, 0]} castShadow>
        <cylinderGeometry args={[0.6, 0.6, 0.08, 24]} />
        <meshStandardMaterial color="#dfbb90" roughness={0.8} />
      </mesh>
    </>
  );
}

function HubFallback() {
  return (
    <>
      <RoundedBox args={[3.2, 0.1, 1.55]} radius={0.05} smoothness={4} position={[0, 0.47, 0]} castShadow>
        <meshStandardMaterial color="#ddd4c5" roughness={0.9} />
      </RoundedBox>
      <RoundedBox args={[3.08, 0.42, 0.16]} radius={0.04} smoothness={4} position={[0, 0.24, 0.69]} castShadow>
        <meshStandardMaterial color="#cfc4b3" roughness={0.92} />
      </RoundedBox>
      {[-1.35, 1.35].map((x, i) => (
        <mesh key={i} position={[x, 0.23, -0.56]} castShadow>
          <boxGeometry args={[0.14, 0.46, 0.14]} />
          <meshStandardMaterial color="#8b7968" />
        </mesh>
      ))}
      {[-1.35, 1.35].map((x, i) => (
        <mesh key={`front-${i}`} position={[x, 0.23, 0.56]} castShadow>
          <boxGeometry args={[0.14, 0.46, 0.14]} />
          <meshStandardMaterial color="#8b7968" />
        </mesh>
      ))}

      <RoundedBox args={[0.96, 0.52, 0.1]} radius={0.03} smoothness={4} position={[0, 0.84, -0.34]} castShadow>
        <meshStandardMaterial color="#c3cdd7" emissive="#9cd3ff" emissiveIntensity={0.08} />
      </RoundedBox>
      <mesh position={[0, 0.66, -0.28]} castShadow>
        <boxGeometry args={[0.1, 0.28, 0.12]} />
        <meshStandardMaterial color="#646c75" />
      </mesh>
      <mesh position={[0, 0.85, -0.395]} castShadow>
        <boxGeometry args={[0.78, 0.34, 0.02]} />
        <meshStandardMaterial color="#9fc9d9" emissive="#9fc9d9" emissiveIntensity={0.38} />
      </mesh>

      <mesh position={[-0.92, 0.53, -0.12]} castShadow>
        <boxGeometry args={[0.42, 0.04, 0.26]} />
        <meshStandardMaterial color="#d6d7d4" />
      </mesh>
      <mesh position={[0.92, 0.53, -0.08]} castShadow>
        <boxGeometry args={[0.48, 0.04, 0.28]} />
        <meshStandardMaterial color="#d6d7d4" />
      </mesh>
      <mesh position={[1.16, 0.57, 0.42]} castShadow>
        <boxGeometry args={[0.62, 0.22, 0.72]} />
        <meshStandardMaterial color="#c9bead" roughness={0.92} />
      </mesh>
      {[0.28, 0.42, 0.56].map((y, i) => (
        <mesh key={`pilot-drawer-${i}`} position={[1.42, y, 0.56]} castShadow>
          <boxGeometry args={[0.03, 0.07, 0.18]} />
          <meshStandardMaterial color="#7c6b5d" />
        </mesh>
      ))}

      <group position={[0, 0.02, -0.88]} rotation={[0, Math.PI, 0]}>
        <mesh position={[0, 0.28, 0]} castShadow>
          <boxGeometry args={[0.6, 0.09, 0.56]} />
          <meshStandardMaterial color="#637589" />
        </mesh>
        <mesh position={[0, 0.58, 0.18]} castShadow>
          <boxGeometry args={[0.58, 0.46, 0.12]} />
          <meshStandardMaterial color="#6c7f95" />
        </mesh>
        <mesh position={[0, 0.14, 0]} castShadow>
          <cylinderGeometry args={[0.05, 0.06, 0.28, 14]} />
          <meshStandardMaterial color="#5d574f" />
        </mesh>
        {[
          [-0.27, 0.04, 0.22],
          [0.27, 0.04, 0.22],
          [-0.29, 0.04, -0.16],
          [0.29, 0.04, -0.16],
          [0, 0.04, -0.28],
        ].map((leg, i) => (
          <mesh key={`pilot-chair-${i}`} position={leg as [number, number, number]} castShadow>
            <boxGeometry args={[0.14, 0.02, 0.04]} />
            <meshStandardMaterial color="#433d38" />
          </mesh>
        ))}
      </group>
    </>
  );
}

function DividerFallback({ width = 2.3, height = 1.22 }: { width?: number; height?: number }) {
  return (
    <>
      <RoundedBox args={[width, height, 0.08]} radius={0.03} smoothness={4} position={[0, height / 2, 0]} castShadow>
        <meshStandardMaterial color="#d8ddd8" roughness={0.94} />
      </RoundedBox>
      <mesh position={[0, height * 0.72, 0.05]}>
        <planeGeometry args={[width * 0.88, height * 0.38]} />
        <meshStandardMaterial color="#b8d9ea" transparent opacity={0.45} />
      </mesh>
      {[-width / 2 + 0.12, width / 2 - 0.12].map((x, i) => (
        <mesh key={i} position={[x, 0.28, 0]} castShadow>
          <boxGeometry args={[0.08, 0.56, 0.12]} />
          <meshStandardMaterial color="#9a9288" />
        </mesh>
      ))}
    </>
  );
}

function BookshelfFallback({ width = 1.45 }: { width?: number }) {
  return (
    <>
      <RoundedBox args={[width, 1.92, 0.38]} radius={0.04} smoothness={4} position={[0, 0.96, 0]} castShadow>
        <meshStandardMaterial color="#b98f63" roughness={0.86} />
      </RoundedBox>
      {[-0.52, -0.16, 0.2, 0.56].map((y, i) => (
        <mesh key={i} position={[0, 0.96 + y, 0.03]} castShadow>
          <boxGeometry args={[width * 0.9, 0.04, 0.28]} />
          <meshStandardMaterial color="#d8b58b" />
        </mesh>
      ))}
      {[-0.36, -0.06, 0.24].map((x, i) => (
        <mesh key={`book-a-${i}`} position={[x, 0.58 + i * 0.34, 0.16]} castShadow>
          <boxGeometry args={[0.12, 0.26, 0.1]} />
          <meshStandardMaterial color={['#6a8bb6', '#d78058', '#8a9c6b'][i % 3]} />
        </mesh>
      ))}
      {[0.16, 0.32, 0.46].map((x, i) => (
        <mesh key={`book-b-${i}`} position={[x, 0.5 + i * 0.32, 0.16]} castShadow>
          <boxGeometry args={[0.09, 0.22, 0.1]} />
          <meshStandardMaterial color={['#cbb16f', '#59708d', '#b96f6f'][i % 3]} />
        </mesh>
      ))}
    </>
  );
}

function WindowBlindsFallback() {
  return (
    <>
      <mesh position={[0, 1.7, 0]} castShadow>
        <boxGeometry args={[2.7, 0.08, 0.16]} />
        <meshStandardMaterial color="#d2cec4" />
      </mesh>
      {[-0.78, -0.52, -0.26, 0, 0.26, 0.52, 0.78].map((x, i) => (
        <mesh key={i} position={[x, 1.16, 0]} rotation={[0, 0, 0.03 * (i % 2 === 0 ? 1 : -1)]}>
          <planeGeometry args={[0.22, 1.1]} />
          <meshStandardMaterial color="#f4efe3" side={THREE.DoubleSide} />
        </mesh>
      ))}
    </>
  );
}

function OfficeShell({ manifest }: { manifest?: OfficeAssetManifestOverride }) {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
        <planeGeometry args={[24, 22]} />
        <meshStandardMaterial color="#edf3f4" roughness={0.96} />
      </mesh>

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0.05]} receiveShadow>
        <planeGeometry args={[8.2, 12.8]} />
        <meshStandardMaterial color="#d9ece6" roughness={0.98} />
      </mesh>

      {[-4.5, 4.5].map((x) => (
        <mesh key={`desk-pad-${x}`} position={[x, 0.015, -0.25]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[3.1, 12.5]} />
          <meshStandardMaterial color="#dfe8ee" roughness={0.98} />
        </mesh>
      ))}

      {[-3.4, -1.7, 0, 1.7, 3.4].map((x) => (
        <mesh key={`review-line-${x}`} position={[x, 0.02, 3.15]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.6, 0.05]} />
          <meshBasicMaterial color="#b8d4d7" transparent opacity={0.32} />
        </mesh>
      ))}

      <mesh position={[0, 0.02, 4.1]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[6.2, 2.6]} />
        <meshBasicMaterial color="#d7e5f2" transparent opacity={0.85} />
      </mesh>
    </>
  );
}

function BreakArea({ manifest }: { manifest?: OfficeAssetManifestOverride }) {
  return (
    <group position={[5.35, 0, 2.95]}>
      <OfficeAssetSlot slot="breakSofa" manifest={manifest} fallback={<SofaFallback />} />
      <OfficeAssetSlot slot="breakTable" manifest={manifest} position={[-1.22, 0, 0.1]} fallback={<SideTableFallback />} />
    </group>
  );
}

function buildDeskLayouts(topics: TeamTopic[]) {
  const deskRows = Math.ceil(topics.length / 2);
  const inactiveTopics = topics.filter((topic) => !['running', 'recent'].includes(topic.live.status));
  const inactiveColumns = Math.min(2, Math.max(1, inactiveTopics.length));
  const inactiveRows = Math.max(1, Math.ceil(inactiveTopics.length / inactiveColumns));
  const inactiveSpacingX = 1;
  const inactiveSpacingZ = 0.72;
  const inactiveIndexById = new Map(inactiveTopics.map((topic, index) => [topic.topicId, index]));

  return topics.map((topic, index) => {
    const side = index % 2;
    const row = Math.floor(index / 2);
    const jitter = ((hashLabel(topic.topicId) % 7) - 3) * 0.03;
    const x = side === 0 ? -4.3 : 4.3;
    const z = (row - (deskRows - 1) / 2) * 2.28 - 0.55 + jitter;
    const rotationY = Math.PI;

    const inactiveIndex = inactiveIndexById.get(topic.topicId) ?? index;
    const inactiveRow = Math.floor(inactiveIndex / inactiveColumns);
    const inactiveColumn = inactiveIndex % inactiveColumns;
    const standbyX = (inactiveColumn - (inactiveColumns - 1) / 2) * inactiveSpacingX;
    const standbyZ = 0.94 + (inactiveRow - (inactiveRows - 1) / 2) * inactiveSpacingZ;

    const deliveryX = (index - (topics.length - 1) / 2) * 0.82;
    const deliveryZ = 3.22;
    const workerDeskPosition: [number, number, number] = rotationY === 0 ? [x + 0.14, 0, z + 0.48] : [x - 0.14, 0, z - 0.48];

    return {
      topic,
      position: [x, 0, z] as [number, number, number],
      rotationY,
      workerDeskPosition,
      standbyPosition: [standbyX, 0, standbyZ] as [number, number, number],
      deliveryPosition: [deliveryX, 0, deliveryZ] as [number, number, number],
      focusPoint: [side === 0 ? x + 0.75 : x - 0.75, 0.92, z + 0.02] as [number, number, number],
    };
  });
}

function currentAgentAnchor(layout: DeskLayout | null, topic: TeamTopic | null) {
  if (!layout || !topic) return null;
  if (topic.live.status === 'running') return layout.focusPoint;
  if (topic.live.status === 'recent') return [layout.deliveryPosition[0], 0.92, layout.deliveryPosition[2]] as [number, number, number];
  return [layout.standbyPosition[0], 0.92, layout.standbyPosition[2]] as [number, number, number];
}

function OfficeRoom({ topics, reducedMotion, hoveredTopicId, selectedTopicId, manifest, workerAvatarManifest, onHover, onLeave, onSelect }: {
  topics: TeamTopic[];
  reducedMotion: boolean;
  hoveredTopicId: string | null;
  selectedTopicId: string | null;
  manifest?: OfficeAssetManifestOverride;
  workerAvatarManifest?: WorkerAvatarManifest | null;
  onHover: (topicId: string) => void;
  onLeave: (topicId: string) => void;
  onSelect: (topicId: string) => void;
}) {
  const deskLayouts = useMemo<DeskLayout[]>(() => buildDeskLayouts(topics), [topics]);

  return (
    <>
      <color attach="background" args={['#eef5f6']} />
      <fog attach="fog" args={['#eef5f6', 28, 56]} />
      <ambientLight intensity={1.2} color="#ffffff" />
      <hemisphereLight args={['#ffffff', '#dbe8ea', 1.18]} />
      <directionalLight position={[9, 12, 7]} intensity={1.34} color="#fff8ef" castShadow shadow-mapSize-width={1024} shadow-mapSize-height={1024} />
      <pointLight position={[0, 6.8, 5.6]} intensity={3.8} color="#f6ffff" />

      <OfficeShell manifest={manifest} />



      <OfficeAssetSlot slot="hubCore" manifest={manifest} position={[0, 0, 4.15]} fallback={<HubFallback />} />
      <FloatingNameTag name="PILOT" color="#7dffad" position={[0, 1.34, 4.15]} visible />

      {deskLayouts.map((desk, index) => {
        const emphasized = hoveredTopicId === desk.topic.topicId || selectedTopicId === desk.topic.topicId;

        return (
          <group key={desk.topic.topicId}>
            <DeskUnit
              topic={desk.topic}
              position={desk.position}
              rotationY={desk.rotationY}
              reducedMotion={reducedMotion}
              seed={index + 1}
              emphasized={emphasized}
              manifest={manifest}
              onHover={() => onHover(desk.topic.topicId)}
              onLeave={() => onLeave(desk.topic.topicId)}
              onSelect={() => onSelect(desk.topic.topicId)}
            />
            <WorkerAvatar
              topic={desk.topic}
              standbyPosition={desk.standbyPosition}
              deskPosition={desk.workerDeskPosition}
              deliveryPosition={desk.deliveryPosition}
              deskFacing={desk.rotationY === 0 ? Math.PI : 0}
              reducedMotion={reducedMotion}
              seed={index + 1}
              emphasized={emphasized}
              manifest={workerAvatarManifest}
              onHover={() => onHover(desk.topic.topicId)}
              onLeave={() => onLeave(desk.topic.topicId)}
              onSelect={() => onSelect(desk.topic.topicId)}
            />
          </group>
        );
      })}

      <ContactShadows position={[0, 0.02, 0.8]} opacity={0.22} scale={34} blur={3.1} far={10} />

      <EffectComposer>
        <Bloom intensity={0.3} luminanceThreshold={0.66} luminanceSmoothing={0.9} />
        <Vignette offset={0.1} darkness={0.18} />
      </EffectComposer>
    </>
  );
}

function CameraDirector({ controlsRef, mode, focusTarget, isMobile, reducedMotion }: {
  controlsRef: RefObject<OrbitControlsImpl>;
  mode: CameraMode;
  focusTarget: [number, number, number] | null;
  isMobile: boolean;
  reducedMotion: boolean;
}) {
  const { camera } = useThree();
  const targetVec = useRef(new THREE.Vector3());
  const offsetVec = useRef(new THREE.Vector3());
  const destination = useRef(new THREE.Vector3());

  useFrame((_, delta) => {
    if (mode === 'free') return;

    const overviewTarget: [number, number, number] = [0, 1.15, 1.9];
    const desiredTarget = mode === 'focus' && focusTarget ? focusTarget : overviewTarget;
    const focusOffset: [number, number, number] = isMobile ? [7.2, 5.2, 8.4] : [8.2, 6.2, 9.5];
    const overviewOffset: [number, number, number] = isMobile ? [18.5, 12.6, 19.8] : [22.8, 15.4, 24.8];

    targetVec.current.set(...desiredTarget);
    if (mode === 'focus' && focusTarget) {
      offsetVec.current.set(...focusOffset);
    } else {
      offsetVec.current.set(...overviewOffset);
    }

    destination.current.copy(targetVec.current).add(offsetVec.current);
    const damping = reducedMotion ? 1 : Math.min(1, delta * 3.3);

    camera.position.lerp(destination.current, damping);

    if (controlsRef.current) {
      controlsRef.current.target.lerp(targetVec.current, damping);
      controlsRef.current.update();
    } else {
      camera.lookAt(targetVec.current);
    }
  });

  return null;
}

function FallbackOffice({ topics }: { topics: TeamTopic[] }) {
  return (
    <div className="relative h-[380px] overflow-hidden rounded-xl border border-[var(--watch-panel-border)] bg-[linear-gradient(180deg,#2a160f,#130d0a)] sm:h-[560px]">
      <div className="absolute inset-6 rounded-xl bg-[#f3ead7]" />
      <div className="absolute left-1/2 top-20 h-28 w-28 -translate-x-1/2 rounded-full bg-[#d9ad84] opacity-90" />
      <div className="absolute right-12 top-28 h-16 w-20 rounded bg-[#6f8dbc]" />
      <div className="absolute inset-x-8 bottom-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {topics.slice(0, 8).map((topic) => (
          <div key={topic.topicId} className="rounded-lg border border-black/10 bg-[rgba(12,12,16,0.84)] px-3 py-2 text-white shadow-lg">
            <div className="truncate text-[10px] uppercase tracking-[0.16em] text-white/65">{topicDisplayLabel(topic)}</div>
            <div className="mt-1 text-[11px]" style={{ color: statusColor(topic.live.status) }}>{actionLabel(topic)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TopicInfoCard({ topic, isMobile, expanded, onToggle }: { topic: TeamTopic | null; isMobile: boolean; expanded: boolean; onToggle: () => void }) {
  if (!topic) return null;
  const color = statusColor(topic.live.status);

  if (isMobile) {
    if (!expanded) {
      return (
        <div className="absolute bottom-3 left-3 z-10 pointer-events-auto">
          <button
            type="button"
            onClick={onToggle}
            className="rounded-lg border border-white/10 bg-[rgba(10,10,14,0.82)] px-3 py-2 text-left text-white shadow-xl backdrop-blur-md"
          >
            <div className="flex items-center gap-2">
              <span className="truncate text-[11px] font-semibold" style={{ color }}>{topicDisplayLabel(topic)}</span>
              <span className="rounded px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em]" style={{ background: `${color}22`, color }}>{topic.live.status}</span>
            </div>
          </button>
        </div>
      );
    }

    return (
      <div className="absolute inset-x-3 bottom-3 z-10 pointer-events-auto rounded-xl border border-white/10 bg-[rgba(10,10,14,0.86)] p-3 text-white shadow-2xl backdrop-blur-md">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[10px] uppercase tracking-[0.18em] text-white/55">agent</div>
            <div className="truncate text-sm font-semibold" style={{ color }}>{topicDisplayLabel(topic)}</div>
          </div>
          <button type="button" onClick={onToggle} className="rounded border border-white/10 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-white/70">hide</button>
        </div>
        <div className="mt-2 text-[10px] uppercase tracking-[0.16em] text-white/50">doing now</div>
        <div className="mt-1 text-xs leading-6 text-white/90">{topicHeadline(topic)}</div>
        <div className="mt-2 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-white/55">
          <span>{actionLabel(topic)}</span>
          <span>{topic.live.freshnessLabel}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute right-3 top-3 z-10 w-[264px] rounded-xl border border-white/10 bg-[rgba(10,10,14,0.84)] p-3 text-white shadow-2xl backdrop-blur-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[11px] uppercase tracking-[0.18em] text-white/60">agent</div>
          <div className="truncate text-base font-semibold" style={{ color }}>{topicDisplayLabel(topic)}</div>
        </div>
        <div className="rounded px-2 py-1 text-[10px] uppercase tracking-[0.14em]" style={{ background: `${color}22`, color }}>
          {topic.live.status}
        </div>
      </div>
      <div className="mt-3 text-[10px] uppercase tracking-[0.16em] text-white/50">doing now</div>
      <div className="mt-1 text-sm leading-6 text-white/90">{topicHeadline(topic)}</div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] uppercase tracking-[0.14em] text-white/55">
        <div>
          <div>mode</div>
          <div className="mt-1 text-[11px] text-white/85">{actionLabel(topic)}</div>
        </div>
        <div>
          <div>freshness</div>
          <div className="mt-1 text-[11px] text-white/85">{topic.live.freshnessLabel}</div>
        </div>
      </div>
    </div>
  );
}

function SceneHud({ running, recent, mode, isMobile, onMode }: {
  running: number;
  recent: number;
  mode: CameraMode;
  isMobile: boolean;
  onMode: (mode: CameraMode) => void;
}) {
  if (isMobile) {
    return (
      <div className="pointer-events-auto absolute right-3 top-3 z-10 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onMode('overview')}
          className="rounded-md border border-white/10 bg-[rgba(10,10,14,0.8)] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-white/70"
        >
          reset
        </button>
      </div>
    );
  }

  const buttonCls = (target: CameraMode) =>
    `rounded border px-2 py-1 text-[10px] uppercase tracking-[0.14em] transition-colors ${
      mode === target
        ? 'border-[rgba(103,232,249,0.45)] bg-[rgba(103,232,249,0.14)] text-[rgb(103,232,249)]'
        : 'border-white/10 bg-[rgba(10,10,14,0.72)] text-white/70 hover:text-white'
    }`;

  return (
    <>
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2">
        <span className="rounded-md border border-[rgba(103,232,249,0.4)] bg-[rgba(103,232,249,0.12)] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[rgb(103,232,249)]">running {running}</span>
        <span className="rounded-md border border-[rgba(251,191,36,0.32)] bg-[rgba(251,191,36,0.1)] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[rgb(251,191,36)]">recent {recent}</span>
      </div>

      <div className="pointer-events-auto absolute right-3 bottom-3 z-10 flex items-center gap-1.5">
        <button type="button" className={buttonCls('overview')} onClick={() => onMode('overview')}>overview</button>
        <button type="button" className={buttonCls('focus')} onClick={() => onMode('focus')}>focus</button>
        <button type="button" className={buttonCls('free')} onClick={() => onMode('free')}>free</button>
      </div>
    </>
  );
}

export function TeamOfficeCanvas({ topics, assetManifest }: { topics: TeamTopic[]; assetManifest?: OfficeAssetManifestOverride }) {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const [fallback, setFallback] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);
  const [hoveredTopicId, setHoveredTopicId] = useState<string | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [mobileInfoExpanded, setMobileInfoExpanded] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>('overview');
  const [localAssetManifest, setLocalAssetManifest] = useState<OfficeAssetManifestOverride>();
  const [workerAvatarManifest, setWorkerAvatarManifest] = useState<WorkerAvatarManifest | null>(null);

  useEffect(() => {
    const updateViewport = () => {
      if (typeof window === 'undefined') return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      setReducedMotion(reduced);
      setFallback(reduced);
      setIsMobile(window.innerWidth < 640);
      setIsLandscape(window.innerWidth > window.innerHeight);
    };

    updateViewport();
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadOfficeLocalAssetManifest(controller.signal).then((manifest) => {
      setLocalAssetManifest(manifest);
    });
    loadWorkerAvatarLocalManifest(controller.signal).then((manifest) => {
      setWorkerAvatarManifest(manifest);
    });
    return () => controller.abort();
  }, []);

  const resolvedAssetManifest = useMemo(
    () => resolveOfficeAssetManifest(assetManifest, localAssetManifest),
    [assetManifest, localAssetManifest],
  );

  useEffect(() => {
    preloadOfficeAssets(resolvedAssetManifest);
    preloadWorkerAvatarAssets(workerAvatarManifest);
  }, [resolvedAssetManifest, workerAvatarManifest]);

  const deskLayouts = useMemo(() => buildDeskLayouts(topics), [topics]);
  const layoutById = useMemo(() => {
    const map = new Map<string, DeskLayout>();
    for (const desk of deskLayouts) map.set(desk.topic.topicId, desk);
    return map;
  }, [deskLayouts]);

  const defaultTopic = topics.find((topic) => topic.live.status === 'running') || topics.find((topic) => topic.live.status === 'recent') || topics[0] || null;
  const hoveredTopic = topics.find((topic) => topic.topicId === hoveredTopicId) || null;
  const selectedTopic = topics.find((topic) => topic.topicId === selectedTopicId) || null;
  const activeTopic = isMobile ? (selectedTopic || hoveredTopic || defaultTopic) : (hoveredTopic || selectedTopic || defaultTopic);

  const focusTopic = selectedTopic || hoveredTopic || defaultTopic;
  const focusLayout = focusTopic ? layoutById.get(focusTopic.topicId) : null;
  const focusTarget = currentAgentAnchor(focusLayout ?? null, focusTopic ?? null);

  const runningCount = topics.filter((topic) => topic.live.status === 'running').length;
  const recentCount = topics.filter((topic) => topic.live.status === 'recent').length;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

      if (event.key.toLowerCase() === 'f') {
        setCameraMode('focus');
      }
      if (event.key.toLowerCase() === 'o') {
        setCameraMode('overview');
      }
      if (event.key === 'Escape') {
        setSelectedTopicId(null);
        setMobileInfoExpanded(false);
        setCameraMode('overview');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (fallback) return <FallbackOffice topics={topics} />;

  return (
    <div className={`relative overflow-hidden rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.12)] ${isMobile && isLandscape ? 'h-[96dvh] min-h-[420px]' : 'h-[86dvh] min-h-[560px] sm:h-[720px] lg:h-[800px]'}`}>
      <Canvas
        shadows
        camera={{ position: [22.8, 15.4, 24.8], fov: isMobile ? 46 : 40, near: 0.1, far: 180 }}
        dpr={typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, window.innerWidth < 768 ? 1.2 : 1.7)}
        onCreated={({ camera }) => {
          camera.lookAt(0, 1.15, 1.65);
        }}
        onPointerMissed={() => {
          setSelectedTopicId(null);
          setMobileInfoExpanded(false);
          if (!isMobile) setCameraMode('overview');
        }}
      >
        <OfficeRoom
          topics={topics}
          reducedMotion={reducedMotion}
          hoveredTopicId={hoveredTopicId}
          selectedTopicId={selectedTopicId}
          manifest={resolvedAssetManifest}
          workerAvatarManifest={workerAvatarManifest}
          onHover={setHoveredTopicId}
          onLeave={(topicId) => {
            setHoveredTopicId((current) => (current === topicId ? null : current));
          }}
          onSelect={(topicId) => {
            setSelectedTopicId(topicId);
            setCameraMode('focus');
            if (isMobile) setMobileInfoExpanded(true);
          }}
        />

        <CameraDirector
          controlsRef={controlsRef}
          mode={cameraMode}
          focusTarget={focusTarget}
          isMobile={isMobile}
          reducedMotion={reducedMotion}
        />

        <OrbitControls
          ref={controlsRef}
          enablePan
          enableZoom
          enableRotate
          enableDamping
          dampingFactor={0.08}
          minDistance={5.2}
          maxDistance={48}
          zoomSpeed={1.35}
          panSpeed={1.2}
          rotateSpeed={0.9}
          minPolarAngle={0.42}
          maxPolarAngle={1.55}
          minAzimuthAngle={-Math.PI}
          maxAzimuthAngle={Math.PI}
          target={[0, 1.15, 1.65]}
          screenSpacePanning
          touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
          onStart={() => setCameraMode('free')}
        />
      </Canvas>

      <SceneHud running={runningCount} recent={recentCount} mode={cameraMode} isMobile={isMobile} onMode={setCameraMode} />

      <TopicInfoCard
        topic={activeTopic}
        isMobile={isMobile}
        expanded={mobileInfoExpanded}
        onToggle={() => setMobileInfoExpanded((value) => !value)}
      />

      {!isMobile && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex flex-wrap gap-2">
          <div className="rounded-md bg-[rgba(10,10,14,0.78)] px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-white/70 shadow-lg">drag to orbit</div>
          <div className="rounded-md bg-[rgba(10,10,14,0.78)] px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-white/70 shadow-lg">F focus · O overview · Esc reset</div>
        </div>
      )}
    </div>
  );
}
