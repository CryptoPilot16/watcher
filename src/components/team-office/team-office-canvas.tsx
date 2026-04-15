'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, Float, OrbitControls, RoundedBox } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { topicDisplayLabel, type TeamTaskSource, type TeamTopic } from '@/lib/watch-team';
import {
  loadOfficeLocalAssetManifest,
  OfficeAssetSlot,
  preloadOfficeAssets,
  resolveOfficeAssetManifest,
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

function hasAssignedTask(topic: TeamTopic) {
  return topic.live.status === 'running' || topic.live.status === 'recent' || topic.currentTask.source !== 'none' || Boolean(topic.currentTask.snippet);
}

function staysAtDesk(topic: TeamTopic) {
  const label = topicDisplayLabel(topic).toLowerCase();
  return topic.configured.role === 'housekeeping_monitor' || label.includes('sky');
}

function actionLabel(topic: TeamTopic) {
  if (topic.live.status === 'running') return sourceLabel(topic.currentTask.source);
  if (topic.live.status === 'recent') return 'delivering';
  if (topic.live.status === 'missing') return 'offline';
  if (hasAssignedTask(topic)) return 'assigned';
  return 'in line';
}

function topicHeadline(topic: TeamTopic) {
  return topic.currentTask.snippet || topic.recent.lastAssistantText || topic.recent.lastUserText || topic.live.freshnessLabel || 'Waiting for work';
}

function topicProgress(topic: TeamTopic) {
  if (typeof topic.currentTask.progress === 'number') return Math.max(0, Math.min(1, topic.currentTask.progress));
  return null;
}

function hashLabel(label: string) {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return hash;
}


function paletteForTopic(topic: TeamTopic) {
  const seed = hashLabel(topicDisplayLabel(topic));
  const skin = ['#f5d9c4', '#e7c09d', '#cb9b78', '#8f5d43'][seed % 4];
  const hair = ['#251d18', '#5f3625', '#2f3243', '#715940'][(seed >> 2) % 4];
  const top = ['#d74f52', '#60c977', '#2f3340', '#7ea6ef', '#f0c84e', '#e7b04f', '#2f7aa6'][(seed >> 4) % 7];
  const bottom = ['#2d3645', '#3a3d46', '#4c5a6b', '#3d4551', '#64728b'][(seed >> 6) % 5];
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
    bodyScale: archetype === 4 ? [1.01, 1.09, 0.97] : archetype === 5 ? [0.95, 1.03, 0.93] : archetype === 1 ? [0.98, 1.04, 0.95] : [0.99, 1.05, 0.95],
    headScale: archetype === 0 ? [1.24, 1.16, 1.12] : archetype === 3 ? [1.18, 1.1, 1.07] : [1.15, 1.08, 1.04],
    shoulderWidth: archetype === 5 ? 0.12 : archetype === 4 ? 0.143 : 0.132,
    legHeight: archetype === 5 ? 0.21 : 0.235,
    armLength: archetype === 4 ? 0.24 : 0.22,
    hasHat: false,
    hatColor: '#2f3340',
    hatBrimColor: '#151515',
    hasApron: false,
    apronColor: '#f3f0ea',
    hasJacket: archetype === 2 || archetype === 3,
    jacketColor: archetype === 2 ? '#e6e1d8' : '#7ea6ef',
    skirt: archetype === 5 || archetype === 6,
    accentStripe: archetype === 0 || archetype === 4,
    hasVest: archetype === 1 || archetype === 4,
    vestColor: ['#44506d', '#665548', '#4c5d55', '#52657f', '#836646', '#63595a', '#5d5678'][archetype],
    hasTie: archetype === 0 || archetype === 2,
    tieColor: archetype === 0 ? '#c74642' : '#506b9f',
    blouseColor: ['#ece5d8', '#efe7dd', '#f3eee5', '#ece8e2', '#efe8de', '#f5f1ea', '#eee4d9'][archetype],
    sockColor: archetype === 5 || archetype === 6 ? '#ddd3c8' : '#5a6170',
    shoeColor: ['#40362f', '#3d3530', '#2f3340', '#4c3c31', '#3d322a', '#4b3934', '#3a3346'][archetype],
    hairStyle: ['part', 'crop', 'bob', 'flip', 'part', 'bun', 'bob'][archetype] as WorkerStyle['hairStyle'],
    hairVolume: archetype === 5 ? 1.08 : archetype === 2 ? 1.04 : 1,
  };
}

type DeskLayout = {
  topic: TeamTopic;
  position: [number, number, number];
  rotationY: number;
  workerDeskPosition: [number, number, number];
  standbyPosition: [number, number, number];
  taskTablePosition: [number, number, number];
  taskTableFacing: number;
  deliveryPosition: [number, number, number];
  focusPoint: [number, number, number];
  deskSeatPosition: [number, number, number];
};

type CameraMode = 'overview' | 'focus' | 'free';

type ProjectBadgeSpec = {
  label: string;
  accent: string;
  imageUrl: string;
  maxWidth: number;
  maxHeight: number;
  position: [number, number, number];
};

function projectBadgeSpec(topic: TeamTopic): ProjectBadgeSpec | null {
  const label = topicDisplayLabel(topic).toLowerCase();
  const base = { position: [0.05, 0.84, -0.438] as [number, number, number] };
  if (label.includes('sky')) return { label: 'SKYBUDDY', accent: '#61d86b', imageUrl: '/project-logos/skybuddy.svg', maxWidth: 0.24, maxHeight: 0.12, ...base };
  if (label.includes('echo') || label.includes('gustavo')) return { label: 'ECHOES', accent: '#7e9bff', imageUrl: '/project-logos/echoes.svg', maxWidth: 0.24, maxHeight: 0.12, ...base };
  if (label.includes('odds') || label.includes('gap')) return { label: 'ODDSGAP', accent: '#ffb84d', imageUrl: '/project-logos/oddsgap-symbol.png', maxWidth: 0.16, maxHeight: 0.16, ...base };
  return null;
}

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

function ProjectDeskBadge({ topic }: { topic: TeamTopic }) {
  const spec = useMemo(() => projectBadgeSpec(topic), [topic]);
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const [aspect, setAspect] = useState(1);

  useEffect(() => {
    if (!spec) {
      setTexture(null);
      setAspect(1);
      return;
    }

    const loader = new THREE.TextureLoader();
    loader.load(
      spec.imageUrl,
      (loaded) => {
        loaded.colorSpace = THREE.SRGBColorSpace;
        loaded.needsUpdate = true;
        const imageWidth = Number((loaded.image as { width?: number })?.width || 1);
        const imageHeight = Number((loaded.image as { height?: number })?.height || 1);
        setAspect(imageWidth > 0 && imageHeight > 0 ? imageWidth / imageHeight : 1);
        setTexture(loaded);
      },
      undefined,
      () => {
        setTexture(null);
        setAspect(1);
      },
    );
  }, [spec]);

  if (!spec || !texture) return null;

  const width = Math.min(spec.maxWidth, spec.maxHeight * aspect);
  const height = Math.min(spec.maxHeight, spec.maxWidth / Math.max(aspect, 0.01));

  return (
    <mesh position={spec.position} renderOrder={19}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial map={texture} transparent alphaTest={0.08} side={THREE.FrontSide} depthWrite={false} toneMapped={false} />
    </mesh>
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

function AlertDiamond({ visible }: { visible: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!mesh.current || !visible) return;
    const t = clock.getElapsedTime();
    mesh.current.rotation.z = Math.PI / 4;
    mesh.current.rotation.y = t * 1.9;
  });

  if (!visible) return null;

  return (
    <Float speed={2.6} rotationIntensity={0.14} floatIntensity={0.62}>
      <mesh ref={mesh} position={[0, 1.9, 0]} castShadow>
        <boxGeometry args={[0.22, 0.22, 0.06]} />
        <meshStandardMaterial color="#ffd86e" emissive="#ffd86e" emissiveIntensity={1.9} />
      </mesh>
    </Float>
  );
}

function AgentProgressBar({ topic }: { topic: TeamTopic }) {
  const fill = useRef<THREE.Mesh>(null);
  const exactProgress = topicProgress(topic);

  useFrame(() => {
    if (!fill.current || exactProgress === null) return;
    const clamped = Math.max(0.06, Math.min(1, exactProgress));
    fill.current.scale.y = clamped;
    fill.current.position.y = -0.25 + clamped * 0.25;
  });

  if (exactProgress === null || topic.live.status !== 'running') return null;

  return (
    <group position={[0, 2.06, 0.02]}>
      <RoundedBox args={[0.18, 0.68, 0.08]} radius={0.085} smoothness={4}>
        <meshStandardMaterial color="#1d1728" roughness={0.42} metalness={0.08} />
      </RoundedBox>
      <RoundedBox args={[0.12, 0.6, 0.052]} radius={0.06} smoothness={4} position={[0, 0, 0.008]}>
        <meshStandardMaterial color="#2b2435" roughness={0.58} metalness={0.04} />
      </RoundedBox>
      <mesh ref={fill} position={[0, 0, 0.018]}>
        <boxGeometry args={[0.082, 0.5, 0.032]} />
        <meshStandardMaterial color="#7dffad" emissive="#5eff8c" emissiveIntensity={0.5} roughness={0.28} metalness={0.02} />
      </mesh>
      <pointLight color="#7dffad" intensity={0.35} distance={1.0} position={[0, 0.06, 0.22]} />
      <pointLight color="#7dffad" intensity={0.22} distance={0.9} position={[0, 0.06, -0.22]} />
    </group>
  );
}

function AvatarHair({ palette, style }: { palette: ReturnType<typeof paletteForTopic>; style: WorkerStyle }) {
  const capScale: [number, number, number] = [style.headScale[0] * 1.05, style.headScale[1] * 0.82 * style.hairVolume, style.headScale[2] * 1.02];

  return (
    <group>
      <mesh castShadow position={[0, 0.92, -0.045]} scale={capScale}>
        <sphereGeometry args={[0.122, 20, 20, 0, Math.PI * 2, 0, Math.PI / 1.86]} />
        <meshStandardMaterial color={palette.hair} roughness={0.72} />
      </mesh>
      {style.hairStyle === 'bob' && (
        <>
          <mesh castShadow position={[0, 0.835, -0.055]} scale={[style.headScale[0] * 1.02, style.headScale[1] * 0.82, style.headScale[2] * 0.92]}>
            <sphereGeometry args={[0.108, 18, 18, 0, Math.PI * 2, Math.PI / 2.35, Math.PI / 1.65]} />
            <meshStandardMaterial color={palette.hair} roughness={0.76} />
          </mesh>
          {[-0.1, 0.1].map((x) => (
            <mesh key={`bob-side-${x}`} castShadow position={[x, 0.84, -0.025]} scale={[0.88, 1.18, 0.78]}>
              <sphereGeometry args={[0.042, 12, 12]} />
              <meshStandardMaterial color={palette.hair} roughness={0.76} />
            </mesh>
          ))}
        </>
      )}
      {style.hairStyle === 'part' && (
        <>
          <mesh castShadow position={[0, 0.885, 0.012]} rotation={[0.22, 0, 0]}>
            <boxGeometry args={[0.18, 0.028, 0.05]} />
            <meshStandardMaterial color={palette.hair} roughness={0.7} />
          </mesh>
          <mesh castShadow position={[-0.06, 0.845, 0.022]} rotation={[0.2, 0.2, -0.18]}>
            <boxGeometry args={[0.065, 0.11, 0.03]} />
            <meshStandardMaterial color={palette.hair} roughness={0.7} />
          </mesh>
        </>
      )}
      {style.hairStyle === 'bun' && (
        <>
          <mesh castShadow position={[0, 0.81, -0.09]}>
            <sphereGeometry args={[0.06, 14, 14]} />
            <meshStandardMaterial color={palette.hair} roughness={0.72} />
          </mesh>
          {[-0.082, 0.082].map((x) => (
            <mesh key={`bun-side-${x}`} castShadow position={[x, 0.87, -0.01]} scale={[0.75, 1.15, 0.72]}>
              <sphereGeometry args={[0.038, 12, 12]} />
              <meshStandardMaterial color={palette.hair} roughness={0.72} />
            </mesh>
          ))}
        </>
      )}
      {style.hairStyle === 'crop' && (
        <mesh castShadow position={[0, 0.905, 0.03]} rotation={[0.36, 0, 0]}>
          <boxGeometry args={[0.19, 0.038, 0.07]} />
          <meshStandardMaterial color={palette.hair} roughness={0.66} />
        </mesh>
      )}
      {style.hairStyle === 'flip' && (
        <>
          <mesh castShadow position={[0, 0.84, -0.07]} scale={[1, 0.95, 0.9]}>
            <sphereGeometry args={[0.1, 16, 16, 0, Math.PI * 2, Math.PI / 2.45, Math.PI / 1.7]} />
            <meshStandardMaterial color={palette.hair} roughness={0.72} />
          </mesh>
          {[-0.11, 0.11].map((x) => (
            <mesh key={`flip-side-${x}`} castShadow position={[x, 0.83, -0.01]} rotation={[0, 0, x < 0 ? -0.35 : 0.35]}>
              <boxGeometry args={[0.04, 0.1, 0.028]} />
              <meshStandardMaterial color={palette.hair} roughness={0.72} />
            </mesh>
          ))}
        </>
      )}
    </group>
  );
}

function WorkerAvatar({ topic, standbyPosition, taskTablePosition, taskTableFacing, deskPosition, deliveryPosition, deskFacing, reducedMotion, seed, emphasized, onHover, onLeave, onSelect }: {
  topic: TeamTopic;
  standbyPosition: [number, number, number];
  taskTablePosition: [number, number, number];
  taskTableFacing: number;
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
  const leftArm = useRef<THREE.Group>(null);
  const rightArm = useRef<THREE.Group>(null);
  const leftLeg = useRef<THREE.Group>(null);
  const rightLeg = useRef<THREE.Group>(null);
  const chest = useRef<THREE.Mesh>(null);
  const palette = useMemo(() => paletteForTopic(topic), [topic]);
  const style = useMemo(() => styleForTopic(topic), [topic]);
  const accent = useMemo(() => new THREE.Color(statusColor(topic.live.status)), [topic.live.status]);
  const assigned = hasAssignedTask(topic);
  const anchoredAtDesk = staysAtDesk(topic);
  const showHousekeepingAlert = topic.configured.role === 'housekeeping_monitor' && topic.live.status === 'recent' && Boolean(topic.recent.lastAssistantText);
  const mode = anchoredAtDesk
    ? 'desk-watch'
    : topic.live.status === 'recent'
      ? 'delivery'
      : assigned
        ? 'job-front'
        : 'standby';

  useFrame(({ clock }) => {
    if (!group.current) return;
    const t = clock.getElapsedTime() + seed * 0.27;
    const stride = Math.sin(t * 5.2) * 0.46;
    const atFront = mode === 'job-front';
    const atDesk = mode === 'desk-watch';
    const anchor = mode === 'delivery' ? deliveryPosition : atDesk ? deskPosition : atFront ? taskTablePosition : standbyPosition;
    const facing = atDesk ? deskFacing : atFront ? taskTableFacing : 0;
    const baseY = atFront ? 0.06 : atDesk ? 0.04 : 0.07;
    const bob = atFront
      ? (!reducedMotion ? Math.sin(t * 1.7) * 0.004 : 0)
      : atDesk
        ? (!reducedMotion ? Math.sin(t * 1.2) * 0.003 : 0)
        : (!reducedMotion ? Math.sin(t * 2.0) * 0.008 : 0);

    group.current.position.set(anchor[0], baseY + bob, anchor[2]);
    group.current.rotation.set(0, facing, 0);

    if (leftArm.current && rightArm.current && leftLeg.current && rightLeg.current) {
      if (mode === 'job-front' && topic.live.status === 'running' && !reducedMotion) {
        leftArm.current.rotation.x = -0.76 + stride * 0.07;
        rightArm.current.rotation.x = -0.68 - stride * 0.07;
        leftLeg.current.rotation.x = 0;
        rightLeg.current.rotation.x = 0;
      } else if (mode === 'job-front') {
        leftArm.current.rotation.x = -0.34;
        rightArm.current.rotation.x = -0.28;
        leftLeg.current.rotation.x = 0;
        rightLeg.current.rotation.x = 0;
      } else if (mode === 'delivery') {
        leftArm.current.rotation.x = -0.2;
        rightArm.current.rotation.x = -0.48;
        leftLeg.current.rotation.x = 0;
        rightLeg.current.rotation.x = 0;
      } else if (mode === 'desk-watch') {
        leftArm.current.rotation.x = -1.1;
        rightArm.current.rotation.x = -1.02;
        leftLeg.current.rotation.x = 1.18;
        rightLeg.current.rotation.x = 1.18;
      } else {
        leftArm.current.rotation.x = -0.48;
        rightArm.current.rotation.x = -0.38;
        leftLeg.current.rotation.x = 0;
        rightLeg.current.rotation.x = 0;
      }
    }

    if (chest.current) {
      const emissive = topic.live.status === 'running' ? 0.14 : assigned ? 0.05 : 0.02;
      (chest.current.material as THREE.MeshStandardMaterial).emissiveIntensity = emissive;
    }
  });

  if (topic.live.status === 'missing') {
    return null;
  }

  return (
    <group ref={group}>
      <mesh position={[0, 0.012, 0.02]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.13, 0.17, 18]} />
        <meshBasicMaterial color={accent} transparent opacity={topic.live.status === 'running' ? 0.48 : 0.2} />
      </mesh>
      <group scale={style.bodyScale}>
        <mesh castShadow position={[0, 0.59, 0.02]}>
          <capsuleGeometry args={[0.125, 0.14, 6, 12]} />
          <meshStandardMaterial color={style.blouseColor} />
        </mesh>
        <mesh ref={chest} castShadow position={[0, 0.45, 0.02]}>
          <capsuleGeometry args={[0.118, 0.28, 8, 14]} />
          <meshStandardMaterial color={palette.top} emissive={accent} emissiveIntensity={topic.live.status === 'running' ? 0.14 : 0.02} />
        </mesh>
        <mesh castShadow position={[0, 0.33, 0.06]}>
          <capsuleGeometry args={[0.095, 0.08, 6, 10]} />
          <meshStandardMaterial color={palette.bottom} />
        </mesh>
        {style.hasVest && (
          <mesh castShadow position={[0, 0.45, 0.1]}>
            <capsuleGeometry args={[0.11, 0.24, 8, 12]} />
            <meshStandardMaterial color={style.vestColor} />
          </mesh>
        )}
        {style.hasJacket && (
          <mesh castShadow position={[0, 0.45, 0.09]}>
            <capsuleGeometry args={[0.128, 0.3, 8, 14]} />
            <meshStandardMaterial color={style.jacketColor} />
          </mesh>
        )}
        {style.accentStripe && (
          <mesh castShadow position={[0, 0.45, 0.145]}>
            <boxGeometry args={[0.04, 0.25, 0.02]} />
            <meshStandardMaterial color="#f2eddd" />
          </mesh>
        )}
        {style.hasTie && (
          <>
            <mesh castShadow position={[0, 0.55, 0.145]} rotation={[0, 0, Math.PI / 4]}>
              <boxGeometry args={[0.035, 0.035, 0.018]} />
              <meshStandardMaterial color={style.tieColor} />
            </mesh>
            <mesh castShadow position={[0, 0.46, 0.15]}>
              <boxGeometry args={[0.03, 0.16, 0.018]} />
              <meshStandardMaterial color={style.tieColor} />
            </mesh>
          </>
        )}
        {style.skirt ? (
          <mesh castShadow position={[0, 0.18, 0.05]}>
            <cylinderGeometry args={[0.11, 0.16, 0.22, 10]} />
            <meshStandardMaterial color={palette.bottom} />
          </mesh>
        ) : (
          <>
            <mesh castShadow position={[-0.045, 0.18, 0.05]}>
              <capsuleGeometry args={[0.05, 0.14, 4, 8]} />
              <meshStandardMaterial color={palette.bottom} />
            </mesh>
            <mesh castShadow position={[0.045, 0.18, 0.05]}>
              <capsuleGeometry args={[0.05, 0.14, 4, 8]} />
              <meshStandardMaterial color={palette.bottom} />
            </mesh>
          </>
        )}
        {style.hasApron && (
          <mesh castShadow position={[0, 0.33, 0.13]}>
            <boxGeometry args={[0.14, 0.18, 0.025]} />
            <meshStandardMaterial color={style.apronColor} />
          </mesh>
        )}
        <mesh castShadow position={[0, 0.68, 0.02]}>
          <capsuleGeometry args={[0.03, 0.034, 4, 8]} />
          <meshStandardMaterial color={palette.skin} />
        </mesh>
        <mesh castShadow position={[0, 0.83, -0.01]} scale={style.headScale}>
          <sphereGeometry args={[0.125, 22, 22]} />
          <meshStandardMaterial color={palette.skin} />
        </mesh>
        <AvatarHair palette={palette} style={style} />
        <mesh castShadow position={[0, 0.818, 0.1]} scale={[0.56, 0.66, 0.28]}>
          <sphereGeometry args={[0.082, 18, 18]} />
          <meshStandardMaterial color={palette.skin} />
        </mesh>
        {[-0.046, 0.046].map((x) => (
          <group key={`face-${x}`} position={[x, 0.842, 0.112]}>
            <mesh castShadow scale={[1.26, 1, 0.82]}>
              <sphereGeometry args={[0.0155, 12, 12]} />
              <meshStandardMaterial color="#fffdf8" />
            </mesh>
            <mesh castShadow position={[0, -0.001, 0.008]} scale={[1.12, 1.12, 0.9]}>
              <sphereGeometry args={[0.0068, 10, 10]} />
              <meshStandardMaterial color="#2b241f" />
            </mesh>
            <mesh castShadow position={[0, 0.024, -0.004]} rotation={[0, 0, x < 0 ? 0.16 : -0.16]}>
              <boxGeometry args={[0.028, 0.005, 0.005]} />
              <meshStandardMaterial color={palette.hair} />
            </mesh>
          </group>
        ))}
        {[-0.118, 0.118].map((x) => (
          <mesh key={`ear-${x}`} castShadow position={[x, 0.81, 0.004]} scale={[0.8, 1.05, 0.7]}>
            <sphereGeometry args={[0.022, 10, 10]} />
            <meshStandardMaterial color={palette.skin} />
          </mesh>
        ))}
        <mesh castShadow position={[0, 0.792, 0.122]} scale={[0.75, 1.05, 0.9]}>
          <sphereGeometry args={[0.009, 10, 10]} />
          <meshStandardMaterial color="#ca9a80" />
        </mesh>
        <mesh castShadow position={[0, 0.752, 0.118]} rotation={[0.02, 0, 0.04]}>
          <boxGeometry args={[0.042, 0.006, 0.006]} />
          <meshStandardMaterial color="#ad6768" />
        </mesh>
        {style.hasHat && (
          <group position={[0, 0.965, -0.01]}>
            <mesh castShadow scale={[1.04, 0.72, 1.02]}>
              <sphereGeometry args={[0.132, 20, 20, 0, Math.PI * 2, 0, Math.PI / 1.85]} />
              <meshStandardMaterial color={style.hatColor} roughness={0.82} />
            </mesh>
            <mesh castShadow position={[0, -0.012, 0.086]} rotation={[0.28, 0, 0]}>
              <boxGeometry args={[0.16, 0.02, 0.09]} />
              <meshStandardMaterial color={style.hatBrimColor} roughness={0.84} />
            </mesh>
            <mesh castShadow position={[0, -0.055, -0.055]}>
              <boxGeometry args={[0.16, 0.05, 0.12]} />
              <meshStandardMaterial color={style.hatBrimColor} roughness={0.84} />
            </mesh>
          </group>
        )}
      </group>

      <group ref={leftArm} position={[-style.shoulderWidth, 0.5, 0.04]}>
        <mesh castShadow position={[0, -0.12, 0]}>
          <capsuleGeometry args={[0.034, style.armLength, 4, 9]} />
          <meshStandardMaterial color={style.hasVest ? style.vestColor : palette.top} />
        </mesh>
        <mesh castShadow position={[0, -0.29, 0.01]}>
          <sphereGeometry args={[0.043, 12, 12]} />
          <meshStandardMaterial color={palette.skin} />
        </mesh>
      </group>
      <group ref={rightArm} position={[style.shoulderWidth, 0.5, 0.04]}>
        <mesh castShadow position={[0, -0.12, 0]}>
          <capsuleGeometry args={[0.034, style.armLength, 4, 9]} />
          <meshStandardMaterial color={style.hasVest ? style.vestColor : palette.top} />
        </mesh>
        <mesh castShadow position={[0, -0.29, 0.01]}>
          <sphereGeometry args={[0.043, 12, 12]} />
          <meshStandardMaterial color={palette.skin} />
        </mesh>
      </group>
      <group ref={leftLeg} position={[-0.06, 0.2, 0.06]}>
        <mesh castShadow position={[0, -0.11, 0]}>
          <capsuleGeometry args={[0.038, style.legHeight, 4, 9]} />
          <meshStandardMaterial color={style.skirt ? style.sockColor : palette.bottom} />
        </mesh>
        <mesh castShadow position={[0, -0.25, 0.06]}>
          <boxGeometry args={[0.09, 0.04, 0.15]} />
          <meshStandardMaterial color={style.shoeColor} />
        </mesh>
      </group>
      <group ref={rightLeg} position={[0.06, 0.2, 0.06]}>
        <mesh castShadow position={[0, -0.11, 0]}>
          <capsuleGeometry args={[0.038, style.legHeight, 4, 9]} />
          <meshStandardMaterial color={style.skirt ? style.sockColor : palette.bottom} />
        </mesh>
        <mesh castShadow position={[0, -0.25, 0.06]}>
          <boxGeometry args={[0.09, 0.04, 0.15]} />
          <meshStandardMaterial color={style.shoeColor} />
        </mesh>
      </group>

      <ActivityDiamond visible={emphasized || topic.live.status === 'running'} />
      <AgentProgressBar topic={topic} />
      <AlertDiamond visible={showHousekeepingAlert} />
      <FloatingNameTag name={topicDisplayLabel(topic)} color={statusColor(topic.live.status)} position={[0.18, 1.78, 0.02]} visible={emphasized || topic.live.status === 'running' || topic.live.status === 'recent' || showHousekeepingAlert} />

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
        <capsuleGeometry args={[0.22, 0.95, 6, 12]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </group>
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
      <ProjectDeskBadge topic={topic} />

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

function CommonTaskTableFallback() {
  return (
    <>
      <RoundedBox args={[3.3, 0.12, 1.52]} radius={0.06} smoothness={4} position={[0, 0.76, 0]} castShadow>
        <meshStandardMaterial color="#d8c1a0" roughness={0.88} />
      </RoundedBox>
      <RoundedBox args={[1.1, 0.16, 0.7]} radius={0.04} smoothness={4} position={[0, 0.62, 0]} castShadow>
        <meshStandardMaterial color="#cfb38d" roughness={0.9} />
      </RoundedBox>
      {[-1.34, 1.34].map((x, i) => (
        <mesh key={`leg-${i}`} position={[x, 0.38, -0.46]} castShadow>
          <boxGeometry args={[0.16, 0.76, 0.16]} />
          <meshStandardMaterial color="#8d745d" roughness={0.84} />
        </mesh>
      ))}
      {[-1.34, 1.34].map((x, i) => (
        <mesh key={`front-leg-${i}`} position={[x, 0.38, 0.46]} castShadow>
          <boxGeometry args={[0.16, 0.76, 0.16]} />
          <meshStandardMaterial color="#8d745d" roughness={0.84} />
        </mesh>
      ))}
      {[-0.98, 0, 0.98].map((x, i) => (
        <mesh key={`paper-${i}`} position={[x, 0.83, i === 1 ? -0.08 : 0.08]} rotation={[-Math.PI / 2, 0, (i - 1) * 0.12]}>
          <planeGeometry args={[0.42, 0.28]} />
          <meshStandardMaterial color="#f6f0e5" side={THREE.DoubleSide} />
        </mesh>
      ))}
      <mesh position={[0, 0.86, -0.38]} castShadow rotation={[0, 0.18, 0]}>
        <boxGeometry args={[0.34, 0.1, 0.22]} />
        <meshStandardMaterial color="#6f8dbc" />
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

      <mesh position={[0, 0.015, 4.38]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[6.4, 2.2]} />
        <meshStandardMaterial color="#dfe8ee" roughness={0.98} />
      </mesh>

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

function CommonTaskTable() {
  return (
    <group position={[0, 0, 1.05]}>
      <CommonTaskTableFallback />
    </group>
  );
}

function buildDeskLayouts(topics: TeamTopic[]) {
  const assignedTopics = topics.filter((topic) => hasAssignedTask(topic));
  const inactiveTopics = topics.filter((topic) => !hasAssignedTask(topic) && !['running', 'recent'].includes(topic.live.status));
  const inactiveColumns = Math.min(3, Math.max(1, inactiveTopics.length));
  const inactiveSpacingX = 0.96;
  const inactiveSpacingZ = 0.82;
  const inactiveIndexById = new Map(inactiveTopics.map((topic, index) => [topic.topicId, index]));
  const assignedIndexById = new Map(assignedTopics.map((topic, index) => [topic.topicId, index]));
  const pilotDeskCenter: [number, number, number] = [0, 0, 4.45];
  const frontRowCenter: [number, number, number] = [0, 0, 2.62];
  const frontSlots = [
    [-1.6, 0, 0.06],
    [-0.82, 0, -0.08],
    [0, 0, 0.12],
    [0.82, 0, -0.08],
    [1.6, 0, 0.06],
    [-1.18, 0, -0.56],
    [0, 0, -0.72],
    [1.18, 0, -0.56],
  ] as const;

  return topics.map((topic, index) => {
    const side = index % 2;
    const row = Math.floor(index / 2);
    const jitter = ((hashLabel(topic.topicId) % 7) - 3) * 0.03;
    const deskX = side === 0 ? -4.3 : 4.3;
    const deskZ = (row - (Math.ceil(topics.length / 2) - 1) / 2) * 2.28 - 0.55 + jitter;

    const inactiveIndex = inactiveIndexById.get(topic.topicId) ?? index;
    const inactiveRow = Math.floor(inactiveIndex / inactiveColumns);
    const inactiveColumn = inactiveIndex % inactiveColumns;
    const standbyX = (inactiveColumn - (inactiveColumns - 1) / 2) * inactiveSpacingX;
    const standbyZ = -3.55 + inactiveRow * inactiveSpacingZ;

    const assignedIndex = assignedIndexById.get(topic.topicId);
    const slot = assignedIndex === undefined ? [0, 0, -0.72] as const : frontSlots[assignedIndex % frontSlots.length];
    const ring = assignedIndex === undefined ? 0 : Math.floor(assignedIndex / frontSlots.length);
    const spread = 1 + ring * 0.22;
    const taskTablePosition: [number, number, number] = [frontRowCenter[0] + slot[0] * spread, 0, frontRowCenter[2] + slot[2] * spread];
    const taskTableFacing = Math.atan2(pilotDeskCenter[0] - taskTablePosition[0], pilotDeskCenter[2] - taskTablePosition[2]);

    const deliveryX = (index - (topics.length - 1) / 2) * 0.82;
    const deliveryZ = 3.34;
    const rotationY = Math.PI;
    const chairLocalOffset: [number, number, number] = [0.08, 0, 0.48];
    const sinY = Math.sin(rotationY);
    const cosY = Math.cos(rotationY);
    const deskSeatPosition: [number, number, number] = [
      deskX + chairLocalOffset[0] * cosY - chairLocalOffset[2] * sinY,
      0,
      deskZ + chairLocalOffset[0] * sinY + chairLocalOffset[2] * cosY,
    ];

    return {
      topic,
      position: [deskX, 0, deskZ] as [number, number, number],
      rotationY,
      workerDeskPosition: taskTablePosition,
      standbyPosition: [standbyX, 0, standbyZ] as [number, number, number],
      taskTablePosition,
      taskTableFacing,
      deliveryPosition: [deliveryX, 0, deliveryZ] as [number, number, number],
      focusPoint: [taskTablePosition[0], 0.92, taskTablePosition[2] + 0.12] as [number, number, number],
      deskSeatPosition,
    };
  });
}

function currentAgentAnchor(layout: DeskLayout | null, topic: TeamTopic | null) {
  if (!layout || !topic) return null;
  if (staysAtDesk(topic)) return [layout.deskSeatPosition[0], 0.92, layout.deskSeatPosition[2]] as [number, number, number];
  if (topic.live.status === 'running') return layout.focusPoint;
  if (topic.live.status === 'recent') return [layout.deliveryPosition[0], 0.92, layout.deliveryPosition[2]] as [number, number, number];
  if (hasAssignedTask(topic)) return [layout.taskTablePosition[0], 0.92, layout.taskTablePosition[2]] as [number, number, number];
  return [layout.standbyPosition[0], 0.92, layout.standbyPosition[2]] as [number, number, number];
}

function OfficeRoom({ topics, reducedMotion, hoveredTopicId, selectedTopicId, manifest, onHover, onLeave, onSelect }: {
  topics: TeamTopic[];
  reducedMotion: boolean;
  hoveredTopicId: string | null;
  selectedTopicId: string | null;
  manifest?: OfficeAssetManifestOverride;
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

      <OfficeAssetSlot slot="hubCore" manifest={manifest} position={[0, 0, 4.45]} fallback={<HubFallback />} />
      <FloatingNameTag name="PILOT" color="#7dffad" position={[0, 1.34, 4.45]} visible />

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
              taskTablePosition={desk.taskTablePosition}
              taskTableFacing={desk.taskTableFacing}
              deskPosition={staysAtDesk(desk.topic) ? desk.deskSeatPosition : desk.workerDeskPosition}
              deliveryPosition={desk.deliveryPosition}
              deskFacing={desk.rotationY === 0 ? Math.PI : 0}
              reducedMotion={reducedMotion}
              seed={index + 1}
              emphasized={emphasized}
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
    const focusOffset: [number, number, number] = isMobile ? [8.2, 5.8, 9.6] : [9.4, 6.9, 10.8];
    const overviewOffset: [number, number, number] = isMobile ? [20.5, 13.8, 21.8] : [25.4, 17.1, 27.6];

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
    return () => controller.abort();
  }, []);

  const resolvedAssetManifest = useMemo(
    () => resolveOfficeAssetManifest(assetManifest, localAssetManifest),
    [assetManifest, localAssetManifest],
  );

  useEffect(() => {
    preloadOfficeAssets(resolvedAssetManifest);
  }, [resolvedAssetManifest]);

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
        camera={{ position: [25.4, 17.1, 27.6], fov: isMobile ? 50 : 43, near: 0.1, far: 180 }}
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
          minPolarAngle={0.18}
          maxPolarAngle={Math.PI - 0.08}
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
