'use client';

import { Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Billboard, ContactShadows, Float, OrbitControls, Outlines, RoundedBox, useAnimations, useGLTF } from '@react-three/drei';
import { useLoader } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { MTLLoader, OBJLoader, SkeletonUtils } from 'three-stdlib';
import * as THREE from 'three';
import { topicDisplayLabel, type TeamTaskSource, type TeamTopic } from '@/lib/watch-team';
import {
  loadOfficeLocalAssetManifest,
  OfficeAssetSlot,
  preloadOfficeAssets,
  resolveOfficeAssetManifest,
  type OfficeAssetManifestOverride,
} from './office-asset-pipeline';

type TopicDebugSnapshot = {
  topicId: string;
  label: string;
  status: TeamTopic['live']['status'];
  mode: string;
  position?: [number, number, number];
  target?: [number, number, number];
  displayedProgress?: number;
  barOpacity?: number;
  barVisible?: boolean;
  updatedAt: number;
};

function mergeTopicDebugSnapshot(
  debugRef: { current: Map<string, TopicDebugSnapshot> } | undefined,
  topicId: string,
  patch: Partial<TopicDebugSnapshot>,
) {
  if (!debugRef) return;
  const current = debugRef.current.get(topicId);
  debugRef.current.set(topicId, {
    topicId,
    label: current?.label ?? patch.label ?? topicId,
    status: current?.status ?? patch.status ?? 'idle',
    mode: current?.mode ?? patch.mode ?? 'unknown',
    updatedAt: Date.now(),
    ...current,
    ...patch,
    updatedAt: Date.now(),
  });
}

function formatDebugVec3(value?: [number, number, number]) {
  if (!value) return 'n/a';
  return `${value[0].toFixed(2)}, ${value[1].toFixed(2)}, ${value[2].toFixed(2)}`;
}

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
  if (topic.live.status === 'running' || topic.live.status === 'recent') return true;
  if (topic.live.status === 'missing') return false;
  if (topic.live.status === 'idle') return false;
  return topic.currentTask.source !== 'none' || Boolean(topic.currentTask.snippet);
}


function isAssistantTopic(topic: TeamTopic) {
  const display = topicDisplayLabel(topic).toLowerCase();
  const configured = topic.configured.label.toLowerCase();
  return display.includes('assistant') || configured.includes('assistant');
}

function isHousekeepingTopic(topic: TeamTopic) {
  const display = topicDisplayLabel(topic).toLowerCase();
  const configured = topic.configured.label.toLowerCase();
  const role = topic.configured.role.toLowerCase();
  return role.includes('housekeeping') || configured.includes('house keeping') || display.includes('house keeping') || display.includes('housekeeping');
}

function isProjectDeskTopic(topic: TeamTopic) {
  return projectBadgeSpec(topic) !== null;
}

function shouldSitAtDesk(topic: TeamTopic) {
  if (isHousekeepingTopic(topic)) return true;
  return topic.live.status === 'running' || topic.live.status === 'recent';
}

function staysAtDesk(topic: TeamTopic) {
  return shouldSitAtDesk(topic);
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

let sharedToonGradient: THREE.DataTexture | null = null;
function getToonGradient(): THREE.DataTexture {
  if (!sharedToonGradient) {
    const data = new Uint8Array([40, 40, 40, 255, 140, 140, 140, 255, 255, 255, 255, 255]);
    const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    sharedToonGradient = tex;
  }
  return sharedToonGradient;
}

function buildCarpetTexture(baseHex: string, accentHex: string, seed = 1): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, size, size);
  let s = seed * 9301 + 49297;
  const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let i = 0; i < 38; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 60 + rand() * 140;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, accentHex + '22');
    g.addColorStop(1, accentHex + '00');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let sharedBaseFloorTexture: THREE.CanvasTexture | null | undefined;
function getBaseFloorTexture(): THREE.CanvasTexture | null {
  if (sharedBaseFloorTexture === undefined) {
    sharedBaseFloorTexture = buildCarpetTexture('#dfe3ea', '#b9c1cc', 1);
    if (sharedBaseFloorTexture) sharedBaseFloorTexture.repeat.set(4, 3);
  }
  return sharedBaseFloorTexture;
}
let sharedAisleTexture: THREE.CanvasTexture | null | undefined;
function getAisleTexture(): THREE.CanvasTexture | null {
  if (sharedAisleTexture === undefined) {
    sharedAisleTexture = buildCarpetTexture('#d9ece6', '#b1cbc2', 2);
    if (sharedAisleTexture) sharedAisleTexture.repeat.set(2, 4);
  }
  return sharedAisleTexture;
}
let sharedDeskPadTexture: THREE.CanvasTexture | null | undefined;
function getDeskPadTexture(): THREE.CanvasTexture | null {
  if (sharedDeskPadTexture === undefined) {
    sharedDeskPadTexture = buildCarpetTexture('#cfd6df', '#9fa9b6', 3);
    if (sharedDeskPadTexture) sharedDeskPadTexture.repeat.set(1.4, 4);
  }
  return sharedDeskPadTexture;
}
function FloorTexturedMaterial({ which, color, roughness }: { which: 'base' | 'aisle' | 'desk'; color: string; roughness: number }) {
  const tex = which === 'base' ? getBaseFloorTexture() : which === 'aisle' ? getAisleTexture() : getDeskPadTexture();
  return <meshStandardMaterial color={tex ? '#ffffff' : color} map={tex ?? undefined} roughness={roughness} />;
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
  deskStandPosition: [number, number, number];
};

type CameraMode = 'overview' | 'focus' | 'free';

type ProjectBadgeSpec = {
  label: string;
  accent: string;
  imageUrl: string;
  maxWidth: number;
  maxHeight: number;
  position: [number, number, number];
  rotationY: number;
};

function projectBadgeSpec(topic: TeamTopic): ProjectBadgeSpec | null {
  const label = topicDisplayLabel(topic).toLowerCase();
  const base = {
    position: [0.0, 0.31, 0.43] as [number, number, number],
    rotationY: Math.PI,
  };
  if (label.includes('sky')) return { label: 'SKYBUDDY', accent: '#61d86b', imageUrl: '/project-logos/skybuddy-mark.svg', maxWidth: 0.11, maxHeight: 0.11, ...base };
  if (label.includes('echo')) return { label: 'ECHOES', accent: '#7e9bff', imageUrl: '/project-logos/echoes-mark.svg', maxWidth: 0.11, maxHeight: 0.11, ...base };
  if (label.includes('odds') || label.includes('gap')) return { label: 'ODDSGAP', accent: '#ffb84d', imageUrl: '/project-logos/oddsgap-symbol.png', maxWidth: 0.11, maxHeight: 0.11, ...base };
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
  const [imageTexture, setImageTexture] = useState<THREE.Texture | null>(null);
  const [imageAspect, setImageAspect] = useState(1);

  const fallbackLabel = topicDisplayLabel(topic).toUpperCase();
  const fallbackAccent = statusColor(topic.live.status);
  const fallbackTexture = useMemo(() => {
    if (spec) return null;
    return buildNameTexture(fallbackLabel, fallbackAccent);
  }, [spec, fallbackLabel, fallbackAccent]);

  const fallbackAspect = useMemo(() => {
    if (!fallbackTexture) return 1;
    const imageWidth = Number((fallbackTexture.image as { width?: number })?.width || 1);
    const imageHeight = Number((fallbackTexture.image as { height?: number })?.height || 1);
    return imageWidth > 0 && imageHeight > 0 ? imageWidth / imageHeight : 1;
  }, [fallbackTexture]);

  useEffect(() => {
    if (!spec) {
      setImageTexture(null);
      setImageAspect(1);
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
        setImageAspect(imageWidth > 0 && imageHeight > 0 ? imageWidth / imageHeight : 1);
        setImageTexture(loaded);
      },
      undefined,
      () => {
        setImageTexture(null);
        setImageAspect(1);
      },
    );
  }, [spec]);

  const isProject = Boolean(spec);
  const texture = spec ? imageTexture : fallbackTexture;
  if (!texture) return null;

  if (isProject) {
    const logoSize = 0.26;
    const aspect = imageAspect;
    const w = Math.min(logoSize, (logoSize / Math.max(aspect, 0.01)) * aspect);
    const h = Math.min(logoSize, logoSize / Math.max(aspect, 0.01));
    const panelPad = 0.06;
    return (
      <group position={[-0.1, 0.82, -0.52]}>
        <RoundedBox args={[w + panelPad, h + panelPad, 0.022]} radius={0.02} smoothness={4}>
          <meshStandardMaterial color="#1a1820" roughness={0.9} />
        </RoundedBox>
        <mesh position={[0, 0, -0.012]} renderOrder={19}>
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial map={texture} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      </group>
    );
  }

  const maxWidth = 0.24;
  const maxHeight = 0.062;
  const position = [-0.06, 0.28, 0.32] as [number, number, number];
  const aspect = fallbackAspect;
  const width = Math.min(maxWidth, maxHeight * aspect);
  const height = Math.min(maxHeight, maxWidth / Math.max(aspect, 0.01));
  return (
    <mesh position={position} renderOrder={19}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial map={texture} transparent alphaTest={0.08} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

function ActivityDiamond({ visible, hasBar }: { visible: boolean; hasBar?: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!mesh.current || !visible) return;
    const t = clock.getElapsedTime();
    mesh.current.rotation.y = t * 1.35;
  });

  if (!visible) return null;

  return (
    <Float speed={2.1} rotationIntensity={0.18} floatIntensity={hasBar ? 0.35 : 0.55}>
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

function buildStripeTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size * 4;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#7aff2a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(180,255,100,0.35)';
  ctx.lineWidth = 4;
  const step = 14;
  for (let y = -canvas.height; y < canvas.height * 2; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y + canvas.width * 0.7);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  return tex;
}

function AgentProgressBar({ topic, debugRef }: { topic: TeamTopic; debugRef?: { current: Map<string, TopicDebugSnapshot> } }) {
  const group = useRef<THREE.Group>(null);
  const fill = useRef<THREE.Mesh>(null);
  const burstRing = useRef<THREE.Mesh>(null);
  const burstGlow = useRef<THREE.Mesh>(null);
  const wellMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const fillMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const burstRingMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const burstGlowMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const stripeTexture = useMemo(() => buildStripeTexture(), []);
  const exactProgress = topicProgress(topic);
  const isRunning = topic.live.status === 'running';
  const hiddenForTopic = isHousekeepingTopic(topic);
  const startTime = useRef<number | null>(null);
  const displayedProgress = useRef(0);
  const displayedOpacity = useRef(0);
  const lastStatus = useRef<TeamTopic['live']['status']>(topic.live.status);
  const completionStartTime = useRef<number | null>(null);
  const completionBurstStart = useRef<number | null>(null);
  const completionFrom = useRef(0);

  useEffect(() => () => {
    stripeTexture.dispose();
  }, [stripeTexture]);

  useFrame(({ clock }, delta) => {
    if (!group.current || !fill.current || !wellMaterial.current || !fillMaterial.current || !burstRing.current || !burstGlow.current || !burstRingMaterial.current || !burstGlowMaterial.current || hiddenForTopic) {
      startTime.current = null;
      completionStartTime.current = null;
      completionBurstStart.current = null;
      return;
    }

    const t = clock.getElapsedTime();
    const wasRunning = lastStatus.current === 'running';

    if (isRunning && !wasRunning) {
      startTime.current = t;
      completionStartTime.current = null;
      completionBurstStart.current = null;
      displayedProgress.current = 0;
      displayedOpacity.current = 0;
    } else if (!isRunning && wasRunning) {
      completionStartTime.current = t;
      completionBurstStart.current = t;
      completionFrom.current = displayedProgress.current;
    }
    lastStatus.current = topic.live.status;

    let targetProgress = displayedProgress.current;
    let targetOpacity = 0;

    if (isRunning) {
      if (startTime.current === null) startTime.current = t;
      const elapsed = t - startTime.current;
      targetProgress = exactProgress !== null ? exactProgress : (1 - Math.exp(-elapsed / 10));
      targetOpacity = 1;
    } else if (completionStartTime.current !== null) {
      const completionPhase = Math.min(1, (t - completionStartTime.current) / 0.85);
      targetProgress = THREE.MathUtils.lerp(completionFrom.current, 1, Math.min(1, completionPhase * 1.8));
      targetOpacity = completionPhase < 0.35 ? 1 : Math.max(0, 1 - (completionPhase - 0.35) / 0.65);
      if (completionPhase >= 1) {
        completionStartTime.current = null;
        startTime.current = null;
      }
    } else {
      targetProgress = 0;
      targetOpacity = 0;
      startTime.current = null;
    }

    displayedProgress.current = THREE.MathUtils.damp(displayedProgress.current, Math.max(0, Math.min(1, targetProgress)), 12, delta);
    displayedOpacity.current = THREE.MathUtils.damp(displayedOpacity.current, targetOpacity, 14, delta);

    const burstPhase = completionBurstStart.current === null ? 1 : Math.min(1, (t - completionBurstStart.current) / 0.9);
    if (completionBurstStart.current !== null && burstPhase >= 1) completionBurstStart.current = null;

    const burstPulse = completionBurstStart.current === null ? 0 : Math.sin(burstPhase * Math.PI) * (1 - burstPhase) * 0.45;
    const clamped = Math.max(0.001, Math.min(1, displayedProgress.current));
    fill.current.scale.x = 1 + burstPulse * 0.9;
    fill.current.scale.y = clamped * (1 + burstPulse * 0.35);
    fill.current.scale.z = 1 + burstPulse * 0.5;
    fill.current.position.y = -0.22 + clamped * 0.22;
    group.current.visible = displayedOpacity.current > 0.02 || completionBurstStart.current !== null;
    wellMaterial.current.opacity = displayedOpacity.current * 0.96;
    fillMaterial.current.opacity = displayedOpacity.current;
    fillMaterial.current.color.setHSL(
      completionBurstStart.current === null ? 0.36 : 0.14 + (1 - burstPhase) * 0.04,
      1,
      completionBurstStart.current === null ? 0.52 + Math.sin(t * 5.4) * 0.05 : 0.62 + Math.sin(t * 10) * 0.08,
    );
    stripeTexture.offset.y = isRunning ? -(t * 0.75) % 1 : 0;

    burstGlow.current.visible = completionBurstStart.current !== null;
    burstRing.current.visible = completionBurstStart.current !== null;
    if (completionBurstStart.current !== null) {
      const ringScale = 0.7 + burstPhase * 2.2;
      burstGlow.current.scale.setScalar(0.9 + burstPhase * 1.3);
      burstRing.current.scale.set(ringScale, ringScale, 1);
      burstGlowMaterial.current.opacity = (1 - burstPhase) * 0.28;
      burstRingMaterial.current.opacity = (1 - burstPhase) * 0.95;
    } else {
      burstGlowMaterial.current.opacity = 0;
      burstRingMaterial.current.opacity = 0;
    }
    mergeTopicDebugSnapshot(debugRef, topic.topicId, {
      label: topicDisplayLabel(topic),
      status: topic.live.status,
      displayedProgress: displayedProgress.current,
      barOpacity: displayedOpacity.current,
      barVisible: displayedOpacity.current > 0.02,
    });
  });

  if (hiddenForTopic) return null;

  return (
    <Billboard ref={group as never} position={[0, 2.08, 0]}>
      {/* slim well */}
      <RoundedBox args={[0.07, 0.46, 0.02]} radius={0.03} smoothness={6}>
        <meshBasicMaterial ref={wellMaterial as never} color="#0a0c0f" transparent opacity={0} />
      </RoundedBox>
      <mesh ref={burstGlow as never} position={[0, 0, -0.01]} visible={false}>
        <circleGeometry args={[0.16, 24]} />
        <meshBasicMaterial ref={burstGlowMaterial as never} color="#9fffd2" transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh ref={burstRing as never} position={[0, 0, 0.01]} visible={false}>
        <ringGeometry args={[0.16, 0.22, 28]} />
        <meshBasicMaterial ref={burstRingMaterial as never} color="#ffe66d" transparent opacity={0} toneMapped={false} depthWrite={false} />
      </mesh>
      {/* fill — deeper than well so it shows on front AND back */}
      <RoundedBox ref={fill as never} args={[0.062, 0.44, 0.05]} radius={0.028} smoothness={6} position={[0, 0, 0]}>
        <meshBasicMaterial ref={fillMaterial as never} color="#4aff6e" map={stripeTexture} toneMapped={false} transparent opacity={0} />
      </RoundedBox>
    </Billboard>
  );
}

function AvatarHair({ palette, style }: { palette: ReturnType<typeof paletteForTopic>; style: WorkerStyle }) {
  const capScale: [number, number, number] = [style.headScale[0] * 1.05, style.headScale[1] * 0.82 * style.hairVolume, style.headScale[2] * 1.02];

  return (
    <group>
      <mesh castShadow position={[0, 0.92, -0.045]} scale={capScale}>
        <sphereGeometry args={[0.122, 20, 20, 0, Math.PI * 2, 0, Math.PI / 1.86]} />
        <meshStandardMaterial color={palette.hair} roughness={0.72}  flatShading />
      </mesh>
      {style.hairStyle === 'bob' && (
        <>
          <mesh castShadow position={[0, 0.835, -0.055]} scale={[style.headScale[0] * 1.02, style.headScale[1] * 0.82, style.headScale[2] * 0.92]}>
            <sphereGeometry args={[0.108, 18, 18, 0, Math.PI * 2, Math.PI / 2.35, Math.PI / 1.65]} />
            <meshStandardMaterial color={palette.hair} roughness={0.76}  flatShading />
          </mesh>
          {[-0.1, 0.1].map((x) => (
            <mesh key={`bob-side-${x}`} castShadow position={[x, 0.84, -0.025]} scale={[0.88, 1.18, 0.78]}>
              <sphereGeometry args={[0.042, 8, 8]} />
              <meshStandardMaterial color={palette.hair} roughness={0.76}  flatShading />
            </mesh>
          ))}
        </>
      )}
      {style.hairStyle === 'part' && (
        <>
          <mesh castShadow position={[0, 0.885, 0.012]} rotation={[0.22, 0, 0]}>
            <boxGeometry args={[0.18, 0.028, 0.05]} />
            <meshStandardMaterial color={palette.hair} roughness={0.7}  flatShading />
          </mesh>
          <mesh castShadow position={[-0.06, 0.845, 0.022]} rotation={[0.2, 0.2, -0.18]}>
            <boxGeometry args={[0.065, 0.11, 0.03]} />
            <meshStandardMaterial color={palette.hair} roughness={0.7}  flatShading />
          </mesh>
        </>
      )}
      {style.hairStyle === 'bun' && (
        <>
          <mesh castShadow position={[0, 0.81, -0.09]}>
            <sphereGeometry args={[0.06, 8, 8]} />
            <meshStandardMaterial color={palette.hair} roughness={0.72}  flatShading />
          </mesh>
          {[-0.082, 0.082].map((x) => (
            <mesh key={`bun-side-${x}`} castShadow position={[x, 0.87, -0.01]} scale={[0.75, 1.15, 0.72]}>
              <sphereGeometry args={[0.038, 8, 8]} />
              <meshStandardMaterial color={palette.hair} roughness={0.72}  flatShading />
            </mesh>
          ))}
        </>
      )}
      {style.hairStyle === 'crop' && (
        <mesh castShadow position={[0, 0.905, 0.03]} rotation={[0.36, 0, 0]}>
          <boxGeometry args={[0.19, 0.038, 0.07]} />
          <meshStandardMaterial color={palette.hair} roughness={0.66}  flatShading />
        </mesh>
      )}
      {style.hairStyle === 'flip' && (
        <>
          <mesh castShadow position={[0, 0.84, -0.07]} scale={[1, 0.95, 0.9]}>
            <sphereGeometry args={[0.1, 16, 16, 0, Math.PI * 2, Math.PI / 2.45, Math.PI / 1.7]} />
            <meshStandardMaterial color={palette.hair} roughness={0.72}  flatShading />
          </mesh>
          {[-0.11, 0.11].map((x) => (
            <mesh key={`flip-side-${x}`} castShadow position={[x, 0.83, -0.01]} rotation={[0, 0, x < 0 ? -0.35 : 0.35]}>
              <boxGeometry args={[0.04, 0.1, 0.028]} />
              <meshStandardMaterial color={palette.hair} roughness={0.72}  flatShading />
            </mesh>
          ))}
        </>
      )}
    </group>
  );
}

const CHARACTER_MODELS = [
  '/models/chars/Knight.glb',
  '/models/chars/Barbarian.glb',
  '/models/chars/Mage.glb',
  '/models/chars/Rogue.glb',
  '/models/chars/Rogue_Hooded.glb',
];
CHARACTER_MODELS.forEach((p) => { try { (useGLTF as unknown as { preload: (p: string) => void }).preload(p); } catch {} });

function modelPathForTopic(topic: TeamTopic): string {
  const seed = hashLabel(topic.topicId);
  return CHARACTER_MODELS[seed % CHARACTER_MODELS.length];
}

function GLTFAvatar({ modelPath, animationName }: { modelPath: string; animationName: string }) {
  const gltf = useGLTF(modelPath);
  const cloned = useMemo(() => SkeletonUtils.clone(gltf.scene), [gltf.scene]);
  const group = useRef<THREE.Group>(null);
  const { actions, names } = useAnimations(gltf.animations, group);
  useEffect(() => {
    const resolved = names.includes(animationName) ? animationName : (names.find((n) => n.toLowerCase() === 'idle') ?? names[0]);
    const action = resolved ? actions[resolved] : null;
    if (action) {
      action.reset().fadeIn(0.25).play();
      return () => { action.fadeOut(0.25); };
    }
    return undefined;
  }, [animationName, actions, names]);
  return (
    <group ref={group} scale={0.5} position={[0, 0, 0]}>
      <primitive object={cloned} />
    </group>
  );
}

const ENV_ASSETS = [
  '/models/env/floor_wood.glb',
  '/models/env/wall.glb',
  '/models/env/wall_corner.glb',
  '/models/env/torch_mounted.glb',
  '/models/env/torch_lit.glb',
  '/models/env/banner_green.glb',
  '/models/env/banner_blue.glb',
  '/models/env/banner_red.glb',
  '/models/env/shelf_large.glb',
  '/models/env/shelf_small.glb',
  '/models/env/barrel_large.glb',
  '/models/env/barrel_small.glb',
  '/models/env/crates.glb',
  '/models/env/candle_triple.glb',
  '/models/env/candle_lit.glb',
  '/models/env/chest_gold.glb',
  '/models/env/pillar.glb',
  '/models/env/pillar_decorated.glb',
  '/models/env/chair.glb',
  '/models/env/table_medium.glb',
];
ENV_ASSETS.forEach((p) => (useGLTF as unknown as { preload: (p: string) => void }).preload(p));

function GLBTile({ url, position, rotationY = 0 }: { url: string; position: [number, number, number]; rotationY?: number }) {
  const gltf = useGLTF(url);
  const cloned = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  return <primitive object={cloned} position={position} rotation={[0, rotationY, 0]} />;
}

function GLTFFloorGrid() {
  const tiles: Array<[number, number, number]> = [];
  for (let x = -10; x < 10; x += 4) {
    for (let z = -8; z < 8; z += 4) {
      tiles.push([x + 2, 0, z + 2]);
    }
  }
  return <group>{tiles.map((p, i) => <GLBTile key={i} url="/models/env/floor_tile.glb" position={p} />)}</group>;
}

function VoxelObjInner({ base, position = [0, 0, 0], rotationY = 0, scale = 1 }: { base: string; position?: [number, number, number]; rotationY?: number; scale?: number }) {
  const mtlUrl = `/models/voxel/${base}.mtl`;
  const objUrl = `/models/voxel/${base}.obj`;
  const mtl = useLoader(MTLLoader, mtlUrl);
  const obj = useLoader(OBJLoader, objUrl, (loader) => {
    mtl.preload();
    (loader as OBJLoader).setMaterials(mtl);
  });
  const cloned = useMemo(() => (obj as THREE.Group).clone(true), [obj]);
  return <primitive object={cloned} position={position} rotation={[0, rotationY, 0]} scale={scale} />;
}

function VoxelObj(props: { base: string; position?: [number, number, number]; rotationY?: number; scale?: number }) {
  return (
    <Suspense fallback={null}>
      <VoxelObjInner {...props} />
    </Suspense>
  );
}

function VoxelOfficeScene() {
  const S = 0.95;
  return (
    <>
      {/* Uniform mid-grey floor — matches pilot desk body */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, -0.5]} receiveShadow>
        <planeGeometry args={[24, 20]} />
        <meshStandardMaterial color="#b8bcc2" roughness={0.9} />
      </mesh>
      {/* Central carpet (outer trim) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, -1]} receiveShadow>
        <planeGeometry args={[14.5, 14]} />
        <meshStandardMaterial color="#6e7379" roughness={0.95} />
      </mesh>
      {/* Central carpet (inner) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.0015, -1]} receiveShadow>
        <planeGeometry args={[13.8, 13.4]} />
        <meshStandardMaterial color="#838890" roughness={0.95} />
      </mesh>
      {/* Walls */}
      <mesh position={[0, 2, -9.95]}><boxGeometry args={[24, 4, 0.1]} /><meshStandardMaterial color="#b4b8bd" roughness={0.92} /></mesh>
      <mesh position={[-11.95, 2, 0]}><boxGeometry args={[0.1, 4, 20]} /><meshStandardMaterial color="#b4b8bd" roughness={0.92} /></mesh>
      <mesh position={[11.95, 2, 0]}><boxGeometry args={[0.1, 4, 20]} /><meshStandardMaterial color="#b4b8bd" roughness={0.92} /></mesh>

      {/* Back wall fixtures — flush at wall plane, facing pilot */}
      <group position={[0, 1, -10.65]} scale={[S * 1.1, S * 1.1, -S * 1.1]}>
        <VoxelObj base="Office_Misc_Whiteboard_02" />
      </group>
      <group position={[5.2, 1, -10.65]} scale={[S * 1.1, S * 1.1, -S * 1.1]}>
        <VoxelObj base="Office_Misc_Wall_Corkboard_02" />
      </group>

      {/* LEFT SIDE — Printer station */}
      <VoxelObj base="Office_Table_Brown_2x1_01" position={[-10, 0, -1]} rotationY={Math.PI / 2} scale={S} />
      <VoxelObj base="Office_Misc_Printer" position={[-10, 1.1, -1.4]} scale={S * 0.8} />
      <VoxelObj base="Office_Misc_Fax" position={[-10, 1.1, 0.2]} scale={S * 0.8} />

      {/* BREAK AREA — right-front corner with proper spacing */}
      <VoxelObj base="Office_Couch_White_01" position={[9.5, 0, 2.5]} rotationY={-Math.PI / 2} scale={S} />
      <VoxelObj base="Office_Couch_Black_01" position={[9.5, 0, 6.8]} rotationY={-Math.PI / 2} scale={S} />
      <VoxelObj base="Office_Table_Coffee_01_Black" position={[7.2, 0, 4.6]} rotationY={Math.PI / 2} scale={S} />
      <VoxelObj base="Office_Misc_Coffee_Mug" position={[7.2, 0.5, 4.3]} scale={S} />
      <VoxelObj base="Office_Misc_Coffee_Mug" position={[7.2, 0.5, 4.9]} scale={S} />
      <VoxelObj base="Office_Misc_Plant_03" position={[10.8, 0, 0]} scale={S * 1.1} />

      {/* Filing cabinet (back-left corner) */}
      <VoxelObj base="Office_Misc_Cabinet_01" position={[-10.8, 0, -9]} rotationY={Math.PI / 2} scale={S} />

      {/* Filing cabinets along back-right */}
      <VoxelObj base="Office_Misc_Cabinet_01" position={[10.8, 0, -9]} rotationY={-Math.PI / 2} scale={S} />

      {/* Side door */}
      <VoxelObj base="Office_Misc_Door_01" position={[-11.7, 0, 8]} rotationY={Math.PI / 2} scale={S * 1.1} />

      {/* Plants — floor accents in corners */}
      <VoxelObj base="Office_Misc_Plant_03" position={[-11, 0, -4.5]} scale={S * 1.1} />
      <VoxelObj base="Office_Misc_Plant_02" position={[-11, 0, 5.5]} scale={S} />
      <VoxelObj base="Office_Misc_Plant_01" position={[10.8, 0, 9]} scale={S} />
    </>
  );
}

function MedievalDecorations() {
  const props: Array<{ url: string; pos: [number, number, number]; ry?: number; scale?: number }> = [
    // Wall-mounted torches on back wall (flush at z=-8.0)
    { url: '/models/env/torch_lit.glb', pos: [-6, 2.5, -8.0], ry: 0 },
    { url: '/models/env/torch_lit.glb', pos: [-2, 2.5, -8.0], ry: 0 },
    { url: '/models/env/torch_lit.glb', pos: [2, 2.5, -8.0], ry: 0 },
    { url: '/models/env/torch_lit.glb', pos: [6, 2.5, -8.0], ry: 0 },
    // Side walls (left wall face at x=-10, right at x=+10)
    { url: '/models/env/torch_lit.glb', pos: [-10, 2.5, -4], ry: Math.PI / 2 },
    { url: '/models/env/torch_lit.glb', pos: [-10, 2.5, 4], ry: Math.PI / 2 },
    { url: '/models/env/torch_lit.glb', pos: [10, 2.5, -4], ry: -Math.PI / 2 },
    { url: '/models/env/torch_lit.glb', pos: [10, 2.5, 4], ry: -Math.PI / 2 },
    // Banners on back wall between torches
    { url: '/models/env/banner_green.glb', pos: [-4, 0, -8.3], ry: 0 },
    { url: '/models/env/banner_red.glb', pos: [0, 0, -8.3], ry: 0 },
    { url: '/models/env/banner_blue.glb', pos: [4, 0, -8.3], ry: 0 },
    // Back corners — barrels + crates on the floor
    { url: '/models/env/barrel_large.glb', pos: [-9, 0, -7], ry: 0 },
    { url: '/models/env/barrel_small.glb', pos: [-8, 0, -7.5], ry: 0.3 },
    { url: '/models/env/crates.glb', pos: [9, 0, -7], ry: -0.4 },
    // Shelves along side walls
    { url: '/models/env/shelf_large.glb', pos: [-10, 1.4, 0], ry: Math.PI / 2 },
    { url: '/models/env/shelf_large.glb', pos: [10, 1.4, 0], ry: -Math.PI / 2 },
    // Decorative pillars — back in corners, rotated to face each other
    { url: '/models/env/pillar_decorated.glb', pos: [-9.2, 0, 7], ry: Math.PI / 2 },
    { url: '/models/env/pillar_decorated.glb', pos: [9.2, 0, 7], ry: -Math.PI / 2 },
    // Golden chest centered along back wall
    { url: '/models/env/chest_gold.glb', pos: [0, 0, -7.2], ry: 0 },
    // Candles near pillars
    { url: '/models/env/candle_triple.glb', pos: [-9.2, 0, 6], ry: 0.2 },
    { url: '/models/env/candle_triple.glb', pos: [9.2, 0, 6], ry: -0.2 },
  ];
  return <group>{props.map((p, i) => <GLBTile key={i} url={p.url} position={p.pos} rotationY={p.ry ?? 0} />)}</group>;
}

function GLTFWalls() {
  const walls: Array<{ pos: [number, number, number]; ry: number; url: string }> = [];
  // Back wall (z=-8.5, flush with floor back edge at z=-8)
  for (const x of [-8, -4, 0, 4, 8]) walls.push({ pos: [x, 0, -8.5], ry: 0, url: '/models/env/wall.glb' });
  // Left wall (x=-10.5, flush with floor left edge at x=-10)
  for (const z of [-6, -2, 2, 6]) walls.push({ pos: [-10.5, 0, z], ry: Math.PI / 2, url: '/models/env/wall.glb' });
  // Right wall (x=+10.5)
  for (const z of [-6, -2, 2, 6]) walls.push({ pos: [10.5, 0, z], ry: -Math.PI / 2, url: '/models/env/wall.glb' });
  // Back corners
  walls.push({ pos: [-10.5, 0, -8.5], ry: 0, url: '/models/env/wall_corner.glb' });
  walls.push({ pos: [10.5, 0, -8.5], ry: -Math.PI / 2, url: '/models/env/wall_corner.glb' });
  return <group>{walls.map((w, i) => <GLBTile key={i} url={w.url} position={w.pos} rotationY={w.ry} />)}</group>;
}

function animationForMode(mode: string, status: string): string {
  if (mode === 'victim') return 'Hit_A';
  if (mode === 'discipline') return 'Unarmed_Melee_Attack_Punch_A';
  if (mode === 'delivery') return 'Walking_A';
  if (mode === 'job-front') return 'Walking_A';
  if (mode === 'desk-watch') return 'Sit_Chair_Pose';
  if (mode === 'desk-stand') return 'Idle';
  if (status === 'running') return 'Interact';
  return 'Idle';
}

function WorkerAvatar({
  topic,
  standbyPosition,
  taskTablePosition,
  taskTableFacing,
  deskSeatPosition,
  deskStandPosition,
  deliveryPosition,
  disciplineTargetPosition,
  beingDisciplined,
  disciplineContactRef,
  avatarPositionsRef,
  debugRef,
  deskFacing,
  reducedMotion,
  seed,
  emphasized,
  selected,
  onHover,
  onLeave,
  onSelect,
}: {
  topic: TeamTopic;
  standbyPosition: [number, number, number];
  taskTablePosition: [number, number, number];
  taskTableFacing: number;
  deskSeatPosition: [number, number, number];
  deskStandPosition: [number, number, number];
  deliveryPosition: [number, number, number];
  disciplineTargetPosition: [number, number, number] | null;
  beingDisciplined?: boolean;
  disciplineContactRef?: { current: boolean };
  avatarPositionsRef?: { current: Map<string, THREE.Vector3> };
  debugRef?: { current: Map<string, TopicDebugSnapshot> };
  deskFacing: number;
  reducedMotion: boolean;
  seed: number;
  emphasized: boolean;
  selected: boolean;
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
  const moveTarget = useRef(new THREE.Vector3());
  const initialized = useRef(false);
  const basePalette = useMemo(() => paletteForTopic(topic), [topic]);
  const palette = useMemo(() => {
    if (topic.live.status !== 'missing') return basePalette;
    return {
      skin: '#d6ccc2',
      hair: '#514a48',
      top: '#8d7276',
      bottom: '#666772',
    };
  }, [basePalette, topic.live.status]);
  const style = useMemo(() => styleForTopic(topic), [topic]);
  const accent = useMemo(() => new THREE.Color(statusColor(topic.live.status)), [topic.live.status]);
  const assigned = hasAssignedTask(topic);
  const housekeeping = isHousekeepingTopic(topic);
  const showHousekeepingAlert = housekeeping && topic.live.status === 'recent' && Boolean(topic.recent.lastAssistantText);
  const disciplineMode = housekeeping && Boolean(disciplineTargetPosition);
  const seatedAtDesk = shouldSitAtDesk(topic);
  const [hitPulse, setHitPulse] = useState(false);
  const lastHitRef = useRef(0);
  const contactStartRef = useRef(0);
  useEffect(() => {
    if (!beingDisciplined) { setHitPulse(false); lastHitRef.current = 0; contactStartRef.current = 0; }
  }, [beingDisciplined]);

  const mode = hitPulse
    ? 'victim'
    : disciplineMode
      ? 'discipline'
      : seatedAtDesk
        ? 'desk-watch'
        : 'standby';
  const showHockeyStick = housekeeping && mode === 'discipline';
  const showActivityDiamond = topic.live.status === 'running' || seatedAtDesk || (emphasized && !showHousekeepingAlert);
  const rawAgent = (topic.configured.agent || '').trim();
  const resolvedAgentLabel = !rawAgent || rawAgent.toLowerCase() === 'main'
    ? topicDisplayLabel(topic)
    : rawAgent;
  const hoverLabel = emphasized ? `AGENT ${resolvedAgentLabel}` : topicDisplayLabel(topic);
  const showFloorHalo = topic.live.status === 'running' || emphasized || selected;
  const haloOpacity = topic.live.status === 'running' ? 0.4 : (emphasized || selected ? 0.16 : 0);

  useFrame(({ clock }) => {
    if (!group.current) return;
    const t = clock.getElapsedTime() + seed * 0.27;
    const stride = Math.sin(t * 5.2) * 0.46;
    const atFront = mode === 'job-front';
    const atDesk = mode === 'desk-watch';
    const atDeskStand = mode === 'desk-stand';
    const atDiscipline = mode === 'discipline';
    // disciplineTargetPosition is the victim's seat position — compute an approach position beside them (in the aisle)
    const victimPos = disciplineTargetPosition;
    const disciplineAnchor = victimPos
      ? ([victimPos[0] < 0 ? victimPos[0] + 0.9 : victimPos[0] - 0.9, victimPos[1], victimPos[2]] as [number, number, number])
      : taskTablePosition;
    const anchor = atDiscipline
      ? disciplineAnchor
      : mode === 'delivery'
        ? deliveryPosition
        : atDesk
          ? deskSeatPosition
          : atDeskStand
            ? deskStandPosition
            : atFront
              ? taskTablePosition
              : standbyPosition;
    const facing = atDiscipline && victimPos
      ? Math.atan2(victimPos[0] - disciplineAnchor[0], victimPos[2] - disciplineAnchor[2])
      : (atDesk || atDeskStand)
        ? deskFacing
        : atFront
          ? taskTableFacing
          : 0;
    const baseY = atDesk ? 0.05 : atFront ? 0.06 : 0.07;
    const bob = atFront
      ? (!reducedMotion ? Math.sin(t * 1.7) * 0.004 : 0)
      : atDesk
        ? (!reducedMotion ? Math.sin(t * 1.2) * 0.003 : 0)
        : (!reducedMotion ? Math.sin(t * 2.0) * 0.008 : 0);

    moveTarget.current.set(anchor[0], baseY + bob, anchor[2]);
    // snap to position on first frame — no walking from origin
    if (!initialized.current) {
      initialized.current = true;
      group.current.position.copy(moveTarget.current);
    }

    // Compute separation vector from other avatars (local avoidance)
    const separation = new THREE.Vector3();
    const lockToDeskAnchor = atDesk || atDeskStand;
    if (avatarPositionsRef?.current && !reducedMotion && !lockToDeskAnchor) {
      const AVOID_RADIUS = 0.95;
      const curX = group.current.position.x;
      const curZ = group.current.position.z;
      for (const [otherId, otherPos] of avatarPositionsRef.current) {
        if (otherId === topic.topicId) continue;
        const dx = curX - otherPos.x;
        const dz = curZ - otherPos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < AVOID_RADIUS * AVOID_RADIUS && d2 > 0.0001) {
          const d = Math.sqrt(d2);
          const push = (AVOID_RADIUS - d) / AVOID_RADIUS;
          separation.x += (dx / d) * push;
          separation.z += (dz / d) * push;
        }
      }
    }

    const dist = group.current.position.distanceTo(moveTarget.current);
    const moving = dist > 0.15 && !reducedMotion;
    if (moving) {
      const stepFactor = atDiscipline ? 0.025 : 0.06;
      // Apply separation offset to movement target during travel
      const adjTarget = new THREE.Vector3().copy(moveTarget.current);
      if (separation.lengthSq() > 0) adjTarget.add(separation.multiplyScalar(0.6));
      group.current.position.lerp(adjTarget, stepFactor);
      const walkFacing = Math.atan2(adjTarget.x - group.current.position.x, adjTarget.z - group.current.position.z);
      group.current.rotation.set(0, walkFacing, 0);
    } else if (separation.lengthSq() > 0 && !lockToDeskAnchor) {
      // Even when "at rest", gently push apart if overlapping
      group.current.position.x += separation.x * 0.04;
      group.current.position.z += separation.z * 0.04;
      group.current.rotation.set(0, facing, 0);
    } else {
      group.current.position.copy(moveTarget.current);
      group.current.rotation.set(0, facing, 0);
    }

    // Publish own position to the shared map
    if (avatarPositionsRef?.current) {
      let p = avatarPositionsRef.current.get(topic.topicId);
      if (!p) { p = new THREE.Vector3(); avatarPositionsRef.current.set(topic.topicId, p); }
      p.copy(group.current.position);
    }
    mergeTopicDebugSnapshot(debugRef, topic.topicId, {
      label: topicDisplayLabel(topic),
      status: topic.live.status,
      mode,
      position: [group.current.position.x, group.current.position.y, group.current.position.z],
      target: [moveTarget.current.x, moveTarget.current.y, moveTarget.current.z],
    });

    // Housekeeper signals contact state; victim reads it to trigger hit pulses
    if (mode === 'discipline' && disciplineContactRef) {
      const distToTarget = disciplineAnchor ? Math.hypot(group.current.position.x - disciplineAnchor[0], group.current.position.z - disciplineAnchor[2]) : 999;
      disciplineContactRef.current = distToTarget < 1.4;
    }
    if (beingDisciplined) {
      const tNow = clock.getElapsedTime();
      if (disciplineContactRef?.current) {
        if (contactStartRef.current === 0) contactStartRef.current = tNow;
        const elapsedSinceContact = tNow - contactStartRef.current;
        // Wait for housekeeper's first strike to actually land (punch animation startup)
        if (elapsedSinceContact > 1.1 && tNow - lastHitRef.current > 1.4) {
          lastHitRef.current = tNow;
          setHitPulse(true);
          window.setTimeout(() => setHitPulse(false), 450);
        }
      } else {
        contactStartRef.current = 0;
        lastHitRef.current = 0;
      }
    }

    if (leftArm.current && rightArm.current && leftLeg.current && rightLeg.current) {
      if (mode === 'discipline') {
        const distToTarget = disciplineAnchor ? Math.hypot(group.current.position.x - disciplineAnchor[0], group.current.position.z - disciplineAnchor[2]) : 999;
        const arrived = distToTarget < 1.2;
        if (arrived && !reducedMotion) {
          const swing = Math.sin(t * 5.5);
          const slamPhase = Math.max(0, swing);
          rightArm.current.rotation.x = -2.2 + slamPhase * 1.6;
          leftArm.current.rotation.x = -0.6 + slamPhase * 0.3;
          leftLeg.current.rotation.x = 0.05;
          rightLeg.current.rotation.x = -0.05 + slamPhase * 0.15;
        } else {
          const slowStride = Math.sin(t * 2.8) * 0.36;
          leftArm.current.rotation.x = -0.54 + (reducedMotion ? 0 : slowStride * 0.28);
          rightArm.current.rotation.x = -0.88 - (reducedMotion ? 0 : slowStride * 0.22);
          leftLeg.current.rotation.x = reducedMotion ? 0 : slowStride * 0.4;
          rightLeg.current.rotation.x = reducedMotion ? 0 : -slowStride * 0.4;
        }
      } else if (mode === 'job-front' && topic.live.status === 'running' && !reducedMotion) {
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
        if (beingDisciplined && !reducedMotion) {
          const flinch = Math.sin(t * 5.5);
          const impact = Math.max(0, flinch);
          leftArm.current.rotation.x = -1.8 + impact * 0.5;
          rightArm.current.rotation.x = -1.9 + impact * 0.6;
          leftLeg.current.rotation.x = 1.18;
          rightLeg.current.rotation.x = 1.18;
          if (group.current) { group.current.rotation.z = impact * 0.12; group.current.position.y += impact * 0.015; }
        } else if (dist > 0.15 && !reducedMotion) {
          const walkStride = Math.sin(t * 3.2) * 0.35;
          leftArm.current.rotation.x = -0.48 + walkStride * 0.22;
          rightArm.current.rotation.x = -0.42 - walkStride * 0.22;
          leftLeg.current.rotation.x = walkStride * 0.35;
          rightLeg.current.rotation.x = -walkStride * 0.35;
        } else {
          leftArm.current.rotation.x = -1.1;
          rightArm.current.rotation.x = -1.02;
          leftLeg.current.rotation.x = 1.18;
          rightLeg.current.rotation.x = 1.18;
        }
      } else if (mode === 'desk-stand') {
        leftArm.current.rotation.x = -0.46;
        rightArm.current.rotation.x = -0.34;
        leftLeg.current.rotation.x = reducedMotion ? 0 : stride * 0.08;
        rightLeg.current.rotation.x = reducedMotion ? 0 : -stride * 0.08;
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

  return (
    <group ref={group}>
      <mesh position={[0, 0.012, 0.02]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.13, 0.17, 18]} />
        <meshBasicMaterial color={accent} transparent opacity={showFloorHalo ? haloOpacity : 0} />
      </mesh>
      <GLTFAvatar modelPath={modelPathForTopic(topic)} animationName={animationForMode(mode, topic.live.status)} />


      <ActivityDiamond visible={showActivityDiamond} hasBar={topic.live.status === 'running'} />
      <AgentProgressBar topic={topic} debugRef={debugRef} />
      <AlertDiamond visible={showHousekeepingAlert} />
      <FloatingNameTag name={hoverLabel} color={statusColor(topic.live.status)} position={[0.18, topic.live.status === 'running' ? 2.6 : 1.78, 0.02]} visible={emphasized || topic.live.status === 'running' || topic.live.status === 'recent' || showHousekeepingAlert} />

      <mesh
        position={[0, 0.55, 0]}
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
        <capsuleGeometry args={[0.35, 1.3, 3, 6]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </group>
  );
}

function DeskFallback({ glow, glowStrength, reducedMotion, seed, emphasized, activeDeskWork, sideWallSign = 1 }: {
  glow: THREE.Color;
  glowStrength: number;
  reducedMotion: boolean;
  seed: number;
  emphasized: boolean;
  activeDeskWork: boolean;
  sideWallSign?: 1 | -1;
}) {
  const monitor = useRef<THREE.Mesh>(null);
  const lamp = useRef<THREE.Mesh>(null);
  const screen = useRef<THREE.Mesh>(null);
  const auxScreen = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime() + seed * 0.22;
    if (!reducedMotion) {
      if (monitor.current) monitor.current.rotation.z = Math.sin(t * 0.7) * 0.012;
      if (lamp.current) lamp.current.rotation.z = -0.22 + Math.sin(t * 2.2) * 0.03;
    }

    if (monitor.current) {
      const material = monitor.current.material as THREE.MeshStandardMaterial;
      if (activeDeskWork) {
        material.emissive.set('#4bbfff');
        material.emissiveIntensity = 0.08;
      } else {
        material.emissive.set('#000000');
        material.emissiveIntensity = 0;
      }
    }

    if (screen.current) {
      const material = screen.current.material as THREE.MeshStandardMaterial;
      if (activeDeskWork) {
        material.color.set('#9edfff');
        material.emissive.set('#9edfff');
        material.emissiveIntensity = 0.46;
      } else {
        material.color.set('#14181c');
        material.emissive.set('#000000');
        material.emissiveIntensity = 0;
      }
    }

    if (auxScreen.current) {
      const material = auxScreen.current.material as THREE.MeshStandardMaterial;
      if (activeDeskWork) {
        material.color.set('#72d0ff');
        material.emissive.set('#72d0ff');
        material.emissiveIntensity = 0.28;
      } else {
        material.color.set('#182029');
        material.emissive.set('#000000');
        material.emissiveIntensity = 0;
      }
    }
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
      <mesh position={[-0.1, 0.84, -0.088]} castShadow ref={screen as never}>
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
      <mesh position={[0.3, 0.76, -0.028]} castShadow ref={auxScreen as never}>
        <boxGeometry args={[0.18, 0.12, 0.015]} />
        <meshStandardMaterial color="#8fb7ca" emissive={glow} emissiveIntensity={glowStrength * 0.22} />
      </mesh>
      <mesh position={[0.3, 0.62, -0.15]} castShadow>
        <boxGeometry args={[0.06, 0.1, 0.06]} />
        <meshStandardMaterial color="#6c665f" />
      </mesh>

      <mesh position={[0.58, 0.55, -0.08]} castShadow rotation={[0, 0, -0.28]} ref={lamp}>
        <boxGeometry args={[0.04, 0.34, 0.04]} />
        <meshStandardMaterial color="#57534d" emissive={glow} emissiveIntensity={glowStrength * 0.05} />
      </mesh>
      <mesh position={[0.66, 0.73, -0.15]} castShadow rotation={[0, 0, 0.22]}>
        <coneGeometry args={[0.1, 0.16, 4]} />
        <meshStandardMaterial color="#e8dfcf" emissive="#efe6d7" emissiveIntensity={0.08} />
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
      <RoundedBox args={[0.06, 0.5, 1.02]} radius={0.02} smoothness={4} position={[0.8 * sideWallSign, 0.84, 0.1]} castShadow>
        <meshStandardMaterial color="#b8b6ac" />
      </RoundedBox>
      <mesh position={[0.76 * sideWallSign, 0.86, 0.1]} rotation={[0, sideWallSign > 0 ? Math.PI / 2 : -Math.PI / 2, 0]}>
        <boxGeometry args={[1, 0.32, 0.01]} />
        <meshStandardMaterial color="#95a8a0" />
      </mesh>
    </>
  );
}

function DeskMonitorOverlay({ active }: { active: boolean }) {
  return (
    <group>
      <mesh position={[-0.1, 0.84, -0.084]} renderOrder={24}>
        <boxGeometry args={[0.372, 0.242, 0.012]} />
        <meshStandardMaterial
          color={active ? '#2a3e4a' : '#1b232d'}
          emissive={active ? '#0a1218' : '#000000'}
          emissiveIntensity={active ? 0.03 : 0}
          transparent
          opacity={active ? 0.96 : 0.56}
          metalness={0.02}
          roughness={0.22}
        />
      </mesh>
      <mesh position={[-0.1, 0.84, -0.078]} renderOrder={25}>
        <planeGeometry args={[0.338, 0.204]} />
        <meshBasicMaterial
          color={active ? '#b7f4ff' : '#0f141a'}
          transparent
          opacity={active ? 0.92 : 0.14}
          side={THREE.FrontSide}
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
        />
      </mesh>
    </group>
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
  const seatedAtDesk = shouldSitAtDesk(topic);
  const activeDeskWork = seatedAtDesk;
  const sideWallSign: 1 | -1 = position[0] > 0 ? -1 : 1;

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <OfficeAssetSlot slot="desk" manifest={manifest} fallback={<DeskFallback glow={glow} glowStrength={glowStrength} reducedMotion={reducedMotion} seed={seed} emphasized={emphasized} activeDeskWork={activeDeskWork} sideWallSign={sideWallSign} />} />
      <DeskMonitorOverlay active={activeDeskWork} />

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

function HubFallback({ sceneStyle = 'dungeon' }: { sceneStyle?: SceneStyle }) {
  const topColor = '#ddd4c5';
  const frontColor = '#cfc4b3';
  const legColor = '#8b7968';
  return (
    <>
      <RoundedBox args={[3.2, 0.1, 1.55]} radius={0.05} smoothness={4} position={[0, 0.47, 0]} castShadow>
        <meshStandardMaterial color={topColor} roughness={0.9} />
      </RoundedBox>
      <RoundedBox args={[3.08, 0.42, 0.16]} radius={0.04} smoothness={4} position={[0, 0.24, 0.69]} castShadow>
        <meshStandardMaterial color={frontColor} roughness={0.92} />
      </RoundedBox>
      {[-1.35, 1.35].map((x, i) => (
        <mesh key={i} position={[x, 0.23, -0.56]} castShadow>
          <boxGeometry args={[0.14, 0.46, 0.14]} />
          <meshStandardMaterial color={legColor} />
        </mesh>
      ))}
      {[-1.35, 1.35].map((x, i) => (
        <mesh key={`front-${i}`} position={[x, 0.23, 0.56]} castShadow>
          <boxGeometry args={[0.14, 0.46, 0.14]} />
          <meshStandardMaterial color={legColor} />
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

function OfficeShell({ manifest, sceneStyle = 'dungeon' }: { manifest?: OfficeAssetManifestOverride; sceneStyle?: SceneStyle }) {
  return (
    <>
      {sceneStyle === 'dungeon' && (
        <>
          <GLTFFloorGrid />
          <GLTFWalls />
          <MedievalDecorations />
        </>
      )}
      {sceneStyle === 'office' && <VoxelOfficeScene />}

      {sceneStyle === 'dungeon' && (
        <mesh position={[0, 0.015, 4.45]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[11.4, 2.2]} />
          <meshStandardMaterial color="#dee3ea" roughness={0.98} />
        </mesh>
      )}
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

function isCloneTopic(topic: TeamTopic) {
  const d = topicDisplayLabel(topic).toLowerCase();
  return d.includes('clone');
}

function isCoderTopic(topic: TeamTopic) {
  return topic.configured.role === 'generic_coder' && !projectBadgeSpec(topic) && !isAssistantTopic(topic) && !isCloneTopic(topic) && !isHousekeepingTopic(topic);
}

function isGeneralTopic(topic: TeamTopic) {
  const d = topicDisplayLabel(topic).toLowerCase();
  const r = topic.configured?.role?.toLowerCase() ?? '';
  return (d.includes('general') || r.includes('dispatch') || r.includes('coordination'))
    && !projectBadgeSpec(topic) && !isAssistantTopic(topic) && !isCloneTopic(topic) && !isHousekeepingTopic(topic) && !isCoderTopic(topic);
}

function buildDeskLayouts(topics: TeamTopic[]) {
  // Layout: left=projects+general+assistant, right=coders+housekeeping+clone
  const projectSky = topics.filter((t) => topicDisplayLabel(t).toLowerCase().includes('sky'));
  const projectEchoes = topics.filter((t) => topicDisplayLabel(t).toLowerCase().includes('echo'));
  const projectOdds = topics.filter((t) => { const l = topicDisplayLabel(t).toLowerCase(); return l.includes('odds') || l.includes('gap'); });
  const coders = topics.filter((t) => isCoderTopic(t));
  const generals = topics.filter((t) => isGeneralTopic(t));
  const housekeepingList = topics.filter((t) => isHousekeepingTopic(t) && !projectBadgeSpec(t));
  const assistantList = topics.filter((t) => isAssistantTopic(t) && !projectBadgeSpec(t) && !isCloneTopic(t));
  const cloneList = topics.filter((t) => isCloneTopic(t) && !projectBadgeSpec(t));

  const placed = new Set<string>();
  const leftCol: TeamTopic[] = [];
  const rightCol: TeamTopic[] = [];
  const push = (arr: TeamTopic[], t: TeamTopic) => { if (!placed.has(t.topicId)) { placed.add(t.topicId); arr.push(t); } };

  projectSky.forEach((t) => push(leftCol, t));
  if (coders.length >= 3) push(rightCol, coders[coders.length - 1]);
  projectEchoes.forEach((t) => push(leftCol, t));
  if (coders.length >= 2) push(rightCol, coders[coders.length - 2]);
  projectOdds.forEach((t) => push(leftCol, t));
  if (coders.length >= 1) push(rightCol, coders[coders.length - 3] ?? coders[0]);
  generals.forEach((t) => push(leftCol, t));
  housekeepingList.forEach((t) => push(rightCol, t));
  assistantList.forEach((t) => push(leftCol, t));
  cloneList.forEach((t) => push(rightCol, t));
  for (const t of coders) push(rightCol, t);
  for (const t of topics) { if (!placed.has(t.topicId)) { if (leftCol.length <= rightCol.length) push(leftCol, t); else push(rightCol, t); } }

  const maxRows = Math.max(leftCol.length, rightCol.length, 5);
  const sorted: { topic: TeamTopic; side: number; row: number }[] = [];
  for (let r = 0; r < maxRows; r++) {
    if (r < leftCol.length) sorted.push({ topic: leftCol[r], side: 0, row: r });
    if (r < rightCol.length) sorted.push({ topic: rightCol[r], side: 1, row: r });
  }

  const totalRows = maxRows;
  const assignedTopics = topics.filter((topic) => hasAssignedTask(topic));
  const assignedIndexById = new Map(assignedTopics.map((topic, index) => [topic.topicId, index]));
  const pilotDeskCenter: [number, number, number] = [0, 0, 4.45];
  const frontRowCenter: [number, number, number] = [0, 0, 2.62];
  const frontSlots = [
    [-1.6, 0, 0.06], [-0.82, 0, -0.08], [0, 0, 0.12], [0.82, 0, -0.08],
    [1.6, 0, 0.06], [-1.18, 0, -0.56], [0, 0, -0.72], [1.18, 0, -0.56],
  ] as const;

  return sorted.map(({ topic, side, row }, index) => {
    const jitter = ((hashLabel(topic.topicId) % 7) - 3) * 0.03;
    const deskX = side === 0 ? -4.3 : 4.3;
    const deskZ = (row - (totalRows - 1) / 2) * 2.28 - 1.8 + jitter;

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
    const standingLocalOffset: [number, number, number] = [0.08, 0, 0.88];
    const sinY = Math.sin(rotationY);
    const cosY = Math.cos(rotationY);
    const deskSeatPosition: [number, number, number] = [
      deskX + chairLocalOffset[0] * cosY - chairLocalOffset[2] * sinY,
      0,
      deskZ + chairLocalOffset[0] * sinY + chairLocalOffset[2] * cosY,
    ];
    const deskStandPosition: [number, number, number] = [
      deskX + standingLocalOffset[0] * cosY - standingLocalOffset[2] * sinY,
      0,
      deskZ + standingLocalOffset[0] * sinY + standingLocalOffset[2] * cosY,
    ];
    // Idle/standby should be beside each desk on the aisle side.
    const standbyPosition: [number, number, number] = [
      deskX + (side === 0 ? 1.65 : -1.65),
      0,
      deskZ + 0.02,
    ];

    return {
      topic,
      position: [deskX, 0, deskZ] as [number, number, number],
      rotationY,
      workerDeskPosition: taskTablePosition,
      standbyPosition,
      taskTablePosition,
      taskTableFacing,
      deliveryPosition: [deliveryX, 0, deliveryZ] as [number, number, number],
      focusPoint: [taskTablePosition[0], 0.92, taskTablePosition[2] + 0.12] as [number, number, number],
      deskSeatPosition,
      deskStandPosition,
    };
  });
}

function currentAgentAnchor(layout: DeskLayout | null, topic: TeamTopic | null) {
  if (!layout || !topic) return null;
  if (staysAtDesk(topic)) {
    return [layout.deskSeatPosition[0], 0.92, layout.deskSeatPosition[2]] as [number, number, number];
  }
  return [layout.standbyPosition[0], 0.92, layout.standbyPosition[2]] as [number, number, number];
}

type SceneStyle = 'dungeon' | 'office';

function OfficeRoom({ topics, reducedMotion, hoveredTopicId, selectedTopicId, disciplineDemo, manifest, sceneStyle = 'dungeon', debugRef, onHover, onLeave, onSelect }: {
  topics: TeamTopic[];
  reducedMotion: boolean;
  hoveredTopicId: string | null;
  selectedTopicId: string | null;
  disciplineDemo?: boolean;
  manifest?: OfficeAssetManifestOverride;
  sceneStyle?: SceneStyle;
  debugRef?: { current: Map<string, TopicDebugSnapshot> };
  onHover: (topicId: string) => void;
  onLeave: (topicId: string) => void;
  onSelect: (topicId: string) => void;
}) {
  const deskLayouts = useMemo<DeskLayout[]>(() => buildDeskLayouts(topics), [topics]);
  const disciplineContactRef = useRef(false);
  const avatarPositionsRef = useRef<Map<string, THREE.Vector3>>(new Map());

  const disciplineVictimId = useMemo(() => {
    if (!disciplineDemo) return null;
    const victim = deskLayouts.find((c) => !isHousekeepingTopic(c.topic) && c.topic.live.status !== 'missing');
    return victim?.topic.topicId || null;
  }, [deskLayouts, disciplineDemo]);

  return (
    <>
      <color attach="background" args={['#eef5f6']} />
      <ambientLight intensity={1.2} color="#ffffff" />
      <hemisphereLight args={['#ffffff', '#dbe8ea', 1.18]} />
      <directionalLight position={[9, 12, 7]} intensity={1.34} color="#fff8ef" />
      <pointLight position={[0, 6.8, 5.6]} intensity={3.8} color="#f6ffff" />

      <OfficeShell manifest={manifest} sceneStyle={sceneStyle} />

      <OfficeAssetSlot slot="hubCore" manifest={manifest} position={[0, 0, 4.45]} fallback={<HubFallback sceneStyle={sceneStyle} />} />
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
              deskSeatPosition={desk.deskSeatPosition}
              deskStandPosition={desk.deskStandPosition}
              deliveryPosition={desk.deliveryPosition}
              disciplineTargetPosition={isHousekeepingTopic(desk.topic) && disciplineDemo
                ? (() => {
                    const victim = deskLayouts.find((c) => c.topic.topicId !== desk.topic.topicId && !isHousekeepingTopic(c.topic) && c.topic.live.status !== 'missing');
                    if (!victim) return null;
                    // compute victim's actual rendered position based on their mode
                    const v = victim.topic;
                    const vSeatedAtDesk = shouldSitAtDesk(v);
                    const vOffline = v.live.status === 'missing';
                    let pos: [number, number, number];
                    if (vSeatedAtDesk) pos = victim.deskSeatPosition;
                    else if (vOffline) pos = victim.deskStandPosition;
                    else pos = victim.standbyPosition;
                    return pos;
                  })()
                : null}
              beingDisciplined={desk.topic.topicId === disciplineVictimId}
              disciplineContactRef={disciplineContactRef}
              avatarPositionsRef={avatarPositionsRef}
              debugRef={debugRef}
              deskFacing={desk.rotationY === 0 ? Math.PI : 0}
              reducedMotion={reducedMotion}
              seed={index + 1}
              emphasized={emphasized}
              selected={selectedTopicId === desk.topic.topicId}
              onHover={() => onHover(desk.topic.topicId)}
              onLeave={() => onLeave(desk.topic.topicId)}
              onSelect={() => onSelect(desk.topic.topicId)}
            />
          </group>
        );
      })}

      {/* shadows removed */}

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
  const animating = useRef(false);
  const animProgress = useRef(0);
  const lastMode = useRef(mode);
  const lastFocusId = useRef('');

  useFrame((_, delta) => {
    // detect mode/target changes to trigger a short animation
    const focusId = focusTarget ? focusTarget.join(',') : '';
    if (mode !== lastMode.current || focusId !== lastFocusId.current) {
      lastMode.current = mode;
      lastFocusId.current = focusId;
      if (mode !== 'free') {
        animating.current = true;
        animProgress.current = 0;
      }
    }

    if (mode === 'free' || !animating.current) return;

    const overviewTarget: [number, number, number] = isMobile ? [0, 1.05, 1.35] : [0, 1.15, 1.9];
    const desiredTarget = mode === 'focus' && focusTarget ? focusTarget : overviewTarget;
    const focusOffset: [number, number, number] = isMobile ? [3.2, 2.0, 3.6] : [3.8, 2.3, 4.3];
    const overviewOffset: [number, number, number] = isMobile ? [0, 7.4, 14.5] : [0, 7.2, 14.6];

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

    // stop animating after settling (about 1.5s)
    animProgress.current += delta;
    if (animProgress.current > 1.5) {
      animating.current = false;
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

function InstructInput({ topic, groupId }: { topic: TeamTopic; groupId: string }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);

  const agentId = topic.configured.agent || '';
  const sessionKey = topic.sessionKey || '';
  const threadId = topic.telegram.threadId;
  const canSend = Boolean(agentId && sessionKey && text.trim() && !sending);

  async function submit() {
    const message = text.trim();
    if (!agentId || !message || sending) return;
    setSending(true);
    setStatus(null);
    try {
      const res = await fetch('/api/team-office/instruct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, sessionKey, groupId, threadId, message }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setText('');
      setStatus({
        kind: 'ok',
        message: json.mirrored ? 'sent · mirrored' : json.mirrorError ? 'sent · mirror failed' : 'sent',
      });
    } catch (error: any) {
      setStatus({ kind: 'err', message: String(error?.message || error || 'send failed') });
    } finally {
      setSending(false);
    }
  }

  const disabledReason = !agentId ? 'no agent bound' : !sessionKey ? 'no session bound' : null;

  return (
    <div className="pointer-events-auto mt-3 border-t border-white/10 pt-3">
      <div className="text-[10px] uppercase tracking-[0.16em] text-white/50">instruct</div>
      <div className="mt-1.5 flex items-end gap-2">
        <textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabledReason ? disabledReason : 'add instructions (⌘/Ctrl+Enter)'}
          disabled={Boolean(disabledReason) || sending}
          className="min-h-[38px] flex-1 resize-none rounded-md border border-white/10 bg-[rgba(255,255,255,0.04)] px-2 py-1.5 text-xs leading-5 text-white/90 placeholder:text-white/35 focus:border-[rgba(103,232,249,0.45)] focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          className="shrink-0 rounded-md border border-[rgba(103,232,249,0.4)] bg-[rgba(103,232,249,0.14)] px-2.5 py-1.5 text-[10px] uppercase tracking-[0.18em] text-[rgb(103,232,249)] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? 'sending' : 'send'}
        </button>
      </div>
      {status && (
        <div className={`mt-1.5 text-[10px] uppercase tracking-[0.14em] ${status.kind === 'ok' ? 'text-[rgb(103,232,249)]' : 'text-[#f87171]'}`}>
          {status.message}
        </div>
      )}
    </div>
  );
}

function TopicInfoCard({ topic, groupId, isMobile, expanded, onToggle, disciplineDemo, onDisciplineDemo }: { topic: TeamTopic | null; groupId: string; isMobile: boolean; expanded: boolean; onToggle: () => void; disciplineDemo: boolean; onDisciplineDemo: () => void }) {
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
        {isHousekeepingTopic(topic) && (
          <button type="button" onClick={onDisciplineDemo}
            className={`pointer-events-auto mt-3 w-full rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.18em] transition-colors ${disciplineDemo ? 'border-[rgba(248,113,113,0.5)] bg-[rgba(248,113,113,0.18)] text-[#f87171]' : 'border-[rgba(251,191,36,0.4)] bg-[rgba(251,191,36,0.1)] text-[#fbbf24] hover:bg-[rgba(251,191,36,0.2)]'}`}>
            {disciplineDemo ? 'stop demo' : 'demo discipline'}
          </button>
        )}
        <InstructInput topic={topic} groupId={groupId} />
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
      {isHousekeepingTopic(topic) && (
        <button type="button" onClick={onDisciplineDemo}
          className={`pointer-events-auto mt-3 w-full rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.18em] transition-colors ${disciplineDemo ? 'border-[rgba(248,113,113,0.5)] bg-[rgba(248,113,113,0.18)] text-[#f87171]' : 'border-[rgba(251,191,36,0.4)] bg-[rgba(251,191,36,0.1)] text-[#fbbf24] hover:bg-[rgba(251,191,36,0.2)]'}`}>
          {disciplineDemo ? 'stop demo' : 'demo discipline'}
        </button>
      )}
      <InstructInput topic={topic} groupId={groupId} />
    </div>
  );
}

function CameraPanControls({ controlsRef, onUse, isMobile = false, mobileControlsOpen = false }: { controlsRef: RefObject<OrbitControlsImpl>; onUse?: () => void; isMobile?: boolean; mobileControlsOpen?: boolean }) {
  if (isMobile && !mobileControlsOpen) return null;
  const activeDirs = useRef<Set<'up' | 'down' | 'left' | 'right'>>(new Set());
  const rafRef = useRef<number | null>(null);
  const lastT = useRef<number | null>(null);

  const step = (ts: number) => {
    const controls = controlsRef.current;
    if (!controls) { rafRef.current = null; lastT.current = null; return; }
    const dt = lastT.current == null ? 16 : ts - lastT.current;
    lastT.current = ts;
    if (activeDirs.current.size === 0) { rafRef.current = null; lastT.current = null; return; }
    const PAN_SPEED = 4.2; // units per second
    const camera = controls.object;
    const forward = new THREE.Vector3().subVectors(controls.target, camera.position);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const delta = new THREE.Vector3();
    const amount = PAN_SPEED * (dt / 1000);
    if (activeDirs.current.has('up')) delta.add(forward.clone().multiplyScalar(amount));
    if (activeDirs.current.has('down')) delta.add(forward.clone().multiplyScalar(-amount));
    if (activeDirs.current.has('right')) delta.add(right.clone().multiplyScalar(amount));
    if (activeDirs.current.has('left')) delta.add(right.clone().multiplyScalar(-amount));
    camera.position.add(delta);
    controls.target.add(delta);
    controls.update();
    rafRef.current = requestAnimationFrame(step);
  };

  const startDir = (dir: 'up' | 'down' | 'left' | 'right') => {
    if (activeDirs.current.size === 0) onUse?.();
    activeDirs.current.add(dir);
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(step);
  };
  const stopDir = (dir: 'up' | 'down' | 'left' | 'right') => {
    activeDirs.current.delete(dir);
  };
  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  const handlers = (dir: 'up' | 'down' | 'left' | 'right') => ({
    onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); (e.target as Element).setPointerCapture?.(e.pointerId); startDir(dir); },
    onPointerUp: () => stopDir(dir),
    onPointerLeave: () => stopDir(dir),
    onPointerCancel: () => stopDir(dir),
  });

  const btnCls = isMobile
    ? 'watch-pill h-11 w-11 !p-0 flex items-center justify-center text-[16px] select-none'
    : 'watch-pill h-7 w-7 !p-0 flex items-center justify-center text-[10px] select-none';
  const gridCls = isMobile
    ? 'pointer-events-auto absolute right-3 bottom-[60px] z-10 grid grid-cols-3 grid-rows-3 gap-1.5 w-[132px]'
    : 'pointer-events-auto absolute right-3 bottom-[52px] z-10 grid grid-cols-3 grid-rows-3 gap-1 w-[84px]';

  return (
    <div className={gridCls}>
      <div />
      <button type="button" className={btnCls} aria-label="pan up" {...handlers('up')}>▲</button>
      <div />
      <button type="button" className={btnCls} aria-label="pan left" {...handlers('left')}>◀</button>
      <div />
      <button type="button" className={btnCls} aria-label="pan right" {...handlers('right')}>▶</button>
      <div />
      <button type="button" className={btnCls} aria-label="pan down" {...handlers('down')}>▼</button>
      <div />
    </div>
  );
}

function SceneHud({ running, recent, mode, isMobile, onMode, sceneStyle, onStyle, mobileControlsOpen = false, onToggleMobileControls }: {
  running: number;
  recent: number;
  mode: CameraMode;
  isMobile: boolean;
  onMode: (mode: CameraMode) => void;
  sceneStyle: SceneStyle;
  onStyle: (style: SceneStyle) => void;
  mobileControlsOpen?: boolean;
  onToggleMobileControls?: () => void;
}) {
  const styleBtn = (target: SceneStyle) =>
    `watch-pill text-[11px] uppercase ${sceneStyle === target ? 'watch-pill--active' : ''}`;

  if (isMobile) {
    const compactStyleBtn = (target: SceneStyle) =>
      `watch-pill !px-2 !py-1 text-[10px] uppercase ${sceneStyle === target ? 'watch-pill--active' : ''}`;
    return (
      <>
        <div className="pointer-events-auto absolute right-2 top-2 z-10 flex items-center gap-1">
          <button type="button" className={compactStyleBtn('office')} onClick={() => onStyle('office')}>office</button>
          <button type="button" className={compactStyleBtn('dungeon')} onClick={() => onStyle('dungeon')}>dungeon</button>
          <button type="button" onClick={() => onMode('overview')} className="watch-pill !px-2 !py-1 text-[10px] uppercase">reset</button>
        </div>
        {/* Arrow-grid hide/show toggle on the side */}
        <button
          type="button"
          onClick={onToggleMobileControls}
          aria-label={mobileControlsOpen ? 'hide arrows' : 'show arrows'}
          className="pointer-events-auto absolute right-3 bottom-3 z-10 watch-pill !p-0 w-11 h-11 flex items-center justify-center text-[16px]"
        >
          {mobileControlsOpen ? '✕' : '⤡'}
        </button>
      </>
    );
  }

  const buttonCls = (target: CameraMode) =>
    `watch-pill text-[11px] uppercase ${mode === target ? 'watch-pill--active' : ''}`;

  return (
    <>
      <div className="pointer-events-auto absolute left-3 top-3 z-10 flex items-center gap-1.5">
        <button type="button" className={styleBtn('office')} onClick={() => onStyle('office')}>office</button>
        <button type="button" className={styleBtn('dungeon')} onClick={() => onStyle('dungeon')}>dungeon</button>
      </div>
      <div className="pointer-events-auto absolute right-3 bottom-3 z-10 flex items-center gap-1.5">
        <button type="button" className={buttonCls('overview')} onClick={() => onMode('overview')}>overview</button>
        <button type="button" className={buttonCls('focus')} onClick={() => onMode('focus')}>focus</button>
        <button type="button" className={buttonCls('free')} onClick={() => onMode('free')}>free</button>
      </div>
    </>
  );
}

export function TeamOfficeCanvas({ topics, groupId = '', assetManifest, demo = false, debug = false }: { topics: TeamTopic[]; groupId?: string; assetManifest?: OfficeAssetManifestOverride; demo?: boolean; debug?: boolean }) {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const [fallback, setFallback] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);
  const [hoveredTopicId, setHoveredTopicId] = useState<string | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [mobileInfoExpanded, setMobileInfoExpanded] = useState(false);
  const [disciplineDemo, setDisciplineDemo] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>('overview');
  const [sceneStyle, setSceneStyle] = useState<SceneStyle>('office');
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const [localAssetManifest, setLocalAssetManifest] = useState<OfficeAssetManifestOverride>();
  const [debugSnapshots, setDebugSnapshots] = useState<TopicDebugSnapshot[]>([]);
  const debugRef = useRef<Map<string, TopicDebugSnapshot>>(new Map());

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

  useEffect(() => {
    if (!debug) return;
    debugRef.current = new Map();
    const tick = () => {
      setDebugSnapshots(
        Array.from(debugRef.current.values()).sort((a, b) => a.label.localeCompare(b.label)),
      );
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [debug]);

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
  const activeTopic = selectedTopic;

  const focusTopic = selectedTopic || hoveredTopic || defaultTopic;
  const focusLayout = focusTopic ? layoutById.get(focusTopic.topicId) : null;
  const focusTarget = currentAgentAnchor(focusLayout ?? null, focusTopic ?? null);

  const runningCount = topics.filter((topic) => topic.live.status === 'running').length;
  const recentCount = topics.filter((topic) => topic.live.status === 'recent').length;
  const fallbackDebugSnapshots = useMemo(() => (
    deskLayouts.map((desk) => {
      const atDesk = staysAtDesk(desk.topic);
      const target = atDesk ? desk.deskSeatPosition : desk.standbyPosition;
      return {
        topicId: desk.topic.topicId,
        label: topicDisplayLabel(desk.topic),
        status: desk.topic.live.status,
        mode: atDesk ? 'desk-watch' : 'standby',
        position: target,
        target,
        displayedProgress: topicProgress(desk.topic) ?? undefined,
        barOpacity: desk.topic.live.status === 'running' ? 1 : 0,
        barVisible: desk.topic.live.status === 'running',
        updatedAt: Date.now(),
      } satisfies TopicDebugSnapshot;
    })
  ), [deskLayouts]);

  useEffect(() => {
    if (!debug) return;
    for (const snapshot of fallbackDebugSnapshots) {
      debugRef.current.set(snapshot.topicId, snapshot);
    }
  }, [debug, fallbackDebugSnapshots]);

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
    <div className={`relative overflow-hidden bg-[rgba(0,0,0,0.12)] ${demo ? 'h-full w-full min-h-[320px]' : `rounded-xl border border-[var(--watch-panel-border)] ${isMobile && isLandscape ? 'h-[96dvh] min-h-[420px]' : 'h-[86dvh] min-h-[560px] sm:h-[720px] lg:h-[800px]'}`}`}>
      <Canvas
        camera={{ position: [0, 8.4, 16.5], fov: isMobile ? 44 : 40, near: 0.1, far: 180 }}
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
        <Suspense fallback={null}>
          <OfficeRoom
            topics={topics}
            reducedMotion={reducedMotion}
            hoveredTopicId={hoveredTopicId}
            selectedTopicId={selectedTopicId}
            disciplineDemo={disciplineDemo}
            manifest={resolvedAssetManifest}
            sceneStyle={sceneStyle}
            debugRef={debug ? debugRef : undefined}
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
        </Suspense>

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
          minDistance={3.5}
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

      <SceneHud running={runningCount} recent={recentCount} mode={cameraMode} isMobile={isMobile} onMode={setCameraMode} sceneStyle={sceneStyle} onStyle={setSceneStyle} mobileControlsOpen={mobileControlsOpen} onToggleMobileControls={() => setMobileControlsOpen((v) => !v)} />
      {!demo && <CameraPanControls controlsRef={controlsRef} onUse={() => setCameraMode('free')} isMobile={isMobile} mobileControlsOpen={mobileControlsOpen} />}

      <TopicInfoCard
        topic={activeTopic}
        groupId={groupId}
        isMobile={isMobile}
        expanded={mobileInfoExpanded}
        onToggle={() => setMobileInfoExpanded((value) => !value)}
        disciplineDemo={disciplineDemo}
        onDisciplineDemo={() => setDisciplineDemo((v) => !v)}
      />

      {!isMobile && (
        <div className="pointer-events-none absolute bottom-3 left-[132px] z-10 flex flex-wrap gap-2">
          <div className="rounded-md bg-[rgba(10,10,14,0.78)] px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-white/70 shadow-lg">drag to orbit</div>
          <div className="rounded-md bg-[rgba(10,10,14,0.78)] px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-white/70 shadow-lg">F focus · O overview · Esc reset</div>
        </div>
      )}

      {debug && (
        <div className="absolute right-3 top-14 z-20 max-h-[60vh] w-[min(420px,calc(100%-24px))] overflow-auto rounded-lg border border-[rgba(236,213,141,0.22)] bg-[rgba(12,10,7,0.88)] p-3 text-[11px] text-[var(--watch-text-bright)] shadow-xl backdrop-blur-sm">
          <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-muted)]">debug live avatar state</div>
          <div className="space-y-2 font-mono">
            {(debugSnapshots.length > 0 ? debugSnapshots : fallbackDebugSnapshots).map((snapshot) => (
              <div key={snapshot.topicId} className="rounded border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-2 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{snapshot.label}</span>
                  <span className="uppercase text-[10px] text-[var(--watch-text-muted)]">{snapshot.status}</span>
                </div>
                <div className="mt-1 text-[10px] text-[var(--watch-text-muted)]">mode {snapshot.mode}</div>
                <div className="mt-1 text-[10px] text-[var(--watch-text-muted)]">pos {formatDebugVec3(snapshot.position)}</div>
                <div className="text-[10px] text-[var(--watch-text-muted)]">target {formatDebugVec3(snapshot.target)}</div>
                <div className="text-[10px] text-[var(--watch-text-muted)]">
                  bar {snapshot.barVisible ? 'visible' : 'hidden'} · progress {typeof snapshot.displayedProgress === 'number' ? `${Math.round(snapshot.displayedProgress * 100)}%` : 'n/a'} · opacity {typeof snapshot.barOpacity === 'number' ? snapshot.barOpacity.toFixed(2) : 'n/a'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
