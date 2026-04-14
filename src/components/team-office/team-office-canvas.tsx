'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, Float, OrbitControls, RoundedBox } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import type { TeamTaskSource, TeamTopic } from '@/lib/watch-team';
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


function paletteForTopic(topic: TeamTopic) {
  const seed = hashLabel(topic.configured.label);
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
  hasHat: boolean;
  hatColor: string;
  hatBrimColor: string;
  hasApron: boolean;
  apronColor: string;
  hasJacket: boolean;
  jacketColor: string;
  skirt: boolean;
  accentStripe: boolean;
};

function styleForTopic(topic: TeamTopic): WorkerStyle {
  const seed = hashLabel(topic.configured.label);
  const archetype = seed % 7;
  return {
    bodyScale: archetype === 4 ? [1.02, 1.12, 1] : archetype === 5 ? [0.94, 1.04, 0.96] : [0.98, 1.08, 0.98],
    headScale: archetype === 0 ? [0.96, 1.0, 0.96] : [1, 1, 1],
    shoulderWidth: archetype === 5 ? 0.12 : archetype === 4 ? 0.15 : 0.135,
    legHeight: archetype === 5 ? 0.24 : 0.22,
    hasHat: [0, 3, 4, 6].includes(archetype),
    hatColor: ['#ffffff', '#151820', '#314b88', '#f0c84e', '#f0c84e', '#efe7db', '#5a7fd2'][archetype],
    hatBrimColor: ['#d74f52', '#2f3340', '#2f3340', '#b6892d', '#c89a3b', '#151515', '#2f7aa6'][archetype],
    hasApron: archetype === 5,
    apronColor: '#f3f0ea',
    hasJacket: archetype === 2 || archetype === 3,
    jacketColor: archetype === 2 ? '#e6e1d8' : '#7ea6ef',
    skirt: archetype === 5 || archetype === 6,
    accentStripe: archetype === 0 || archetype === 4,
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
  canvas.width = 260;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(10, 10, 14, 0.78)';
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1.5;

  const x = 4;
  const y = 4;
  const w = canvas.width - 8;
  const h = canvas.height - 8;
  const radius = 12;

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
  ctx.fillRect(12, 11, 7, h - 14);

  ctx.font = '600 22px JetBrains Mono, monospace';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f7f3eb';
  ctx.fillText(name, 28, canvas.height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function FloatingNameTag({ name, color, position, visible = true }: { name: string; color: string; position: [number, number, number]; visible?: boolean }) {
  const texture = useMemo(() => buildNameTexture(name, color), [name, color]);
  if (!texture || !visible) return null;

  return (
    <sprite position={position} scale={[1.62, 0.4, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
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


function WorkerAvatar({ topic, standbyPosition, deskPosition, deliveryPosition, deskFacing, reducedMotion, seed, emphasized, onHover, onLeave, onSelect }: {
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
  const leftArm = useRef<THREE.Group>(null);
  const rightArm = useRef<THREE.Group>(null);
  const leftLeg = useRef<THREE.Group>(null);
  const rightLeg = useRef<THREE.Group>(null);
  const chest = useRef<THREE.Mesh>(null);
  const palette = useMemo(() => paletteForTopic(topic), [topic]);
  const style = useMemo(() => styleForTopic(topic), [topic]);
  const accent = useMemo(() => new THREE.Color(statusColor(topic.live.status)), [topic.live.status]);
  const mode = topic.live.status === 'running' ? 'desk' : topic.live.status === 'recent' ? 'delivery' : 'standby';

  useFrame(({ clock }) => {
    if (!group.current) return;
    const t = clock.getElapsedTime() + seed * 0.27;
    const stride = Math.sin(t * 5.2) * 0.46;
    const anchor = mode === 'desk' ? deskPosition : mode === 'delivery' ? deliveryPosition : standbyPosition;
    const facing = mode === 'desk' ? deskFacing : 0;

    group.current.position.set(anchor[0], 0.26 + (!reducedMotion ? Math.sin(t * 2.0) * 0.013 : 0), anchor[2]);
    group.current.rotation.set(0, facing, 0);

    if (leftArm.current && rightArm.current && leftLeg.current && rightLeg.current) {
      if (mode === 'desk' && !reducedMotion) {
        leftArm.current.rotation.x = -1.05 + stride * 0.09;
        rightArm.current.rotation.x = -0.95 - stride * 0.09;
        leftLeg.current.rotation.x = 0.12;
        rightLeg.current.rotation.x = 0.02;
      } else if (mode === 'delivery') {
        leftArm.current.rotation.x = -0.2;
        rightArm.current.rotation.x = -0.48;
        leftLeg.current.rotation.x = 0;
        rightLeg.current.rotation.x = 0;
      } else {
        leftArm.current.rotation.x = -0.48;
        rightArm.current.rotation.x = -0.38;
        leftLeg.current.rotation.x = 0;
        rightLeg.current.rotation.x = 0;
      }
    }

    if (chest.current) {
      const emissive = topic.live.status === 'running' ? 0.14 : 0.02;
      (chest.current.material as THREE.MeshStandardMaterial).emissiveIntensity = emissive;
    }
  });

  if (topic.live.status === 'missing') {
    return (
      <group position={[standbyPosition[0], 0.2, standbyPosition[2]]}>
        <mesh castShadow>
          <cylinderGeometry args={[0.14, 0.19, 0.24, 16]} />
          <meshStandardMaterial color="#3a1515" emissive="#ff6b6b" emissiveIntensity={0.8} />
        </mesh>
      </group>
    );
  }

  return (
    <group ref={group}>
      <mesh position={[0, 0.05, 0.02]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.13, 0.17, 18]} />
        <meshBasicMaterial color={accent} transparent opacity={topic.live.status === 'running' ? 0.48 : 0.2} />
      </mesh>


<group scale={style.bodyScale}>
  <mesh ref={chest} castShadow position={[0, 0.48, 0.02]}>
    <capsuleGeometry args={[0.1, 0.32, 8, 14]} />
    <meshStandardMaterial color={palette.top} emissive={accent} emissiveIntensity={topic.live.status === 'running' ? 0.14 : 0.02} />
  </mesh>
  {style.hasJacket && (
    <mesh castShadow position={[0, 0.48, 0.07]}>
      <boxGeometry args={[0.25, 0.38, 0.06]} />
      <meshStandardMaterial color={style.jacketColor} />
    </mesh>
  )}
  {style.accentStripe && (
    <mesh castShadow position={[0, 0.5, 0.1]}>
      <boxGeometry args={[0.06, 0.32, 0.02]} />
      <meshStandardMaterial color="#f4f0df" />
    </mesh>
  )}
  <mesh castShadow position={[0, 0.24, 0.05]}>
    <boxGeometry args={[0.18, 0.14, 0.15]} />
    <meshStandardMaterial color={palette.bottom} />
  </mesh>
  {style.skirt && (
    <mesh castShadow position={[0, 0.18, 0.05]}>
      <coneGeometry args={[0.14, 0.22, 8]} />
      <meshStandardMaterial color={palette.bottom} />
    </mesh>
  )}
  {style.hasApron && (
    <mesh castShadow position={[0, 0.34, 0.11]}>
      <boxGeometry args={[0.14, 0.22, 0.03]} />
      <meshStandardMaterial color={style.apronColor} />
    </mesh>
  )}
  <mesh castShadow position={[0, 0.68, -0.02]} scale={style.headScale}>
    <sphereGeometry args={[0.115, 22, 22]} />
    <meshStandardMaterial color={palette.skin} />
  </mesh>
  <mesh castShadow position={[0, 0.78, -0.05]}>
    <sphereGeometry args={[0.126, 20, 20, 0, Math.PI * 2, 0, Math.PI / 2]} />
    <meshStandardMaterial color={palette.hair} roughness={0.72} />
  </mesh>
  <mesh castShadow position={[0, 0.68, 0.095]} rotation={[Math.PI / 2, 0, 0]}>
    <coneGeometry args={[0.022, 0.05, 8]} />
    <meshStandardMaterial color={palette.skin} />
  </mesh>
  {style.hasHat && (
    <group position={[0, 0.82, -0.03]}>
      <mesh castShadow>
        <cylinderGeometry args={[0.1, 0.1, 0.06, 16]} />
        <meshStandardMaterial color={style.hatColor} />
      </mesh>
      <mesh castShadow position={[0, -0.03, 0]}>
        <cylinderGeometry args={[0.14, 0.14, 0.012, 18]} />
        <meshStandardMaterial color={style.hatBrimColor} />
      </mesh>
    </group>
  )}
</group>

<group ref={leftArm} position={[-style.shoulderWidth, 0.5, 0.04]}>
  <mesh castShadow position={[0, -0.12, 0]}>
    <capsuleGeometry args={[0.032, 0.24, 4, 9]} />
    <meshStandardMaterial color={palette.top} />
  </mesh>
</group>
<group ref={rightArm} position={[style.shoulderWidth, 0.5, 0.04]}>
  <mesh castShadow position={[0, -0.12, 0]}>
    <capsuleGeometry args={[0.032, 0.24, 4, 9]} />
    <meshStandardMaterial color={palette.top} />
  </mesh>
</group>
<group ref={leftLeg} position={[-0.058, 0.2, 0.06]}>
  <mesh castShadow position={[0, -0.11, 0]}>
    <capsuleGeometry args={[0.036, style.legHeight, 4, 9]} />
    <meshStandardMaterial color={palette.bottom} />
  </mesh>
  <mesh castShadow position={[0, -0.25, 0.06]}>
    <boxGeometry args={[0.08, 0.04, 0.14]} />
    <meshStandardMaterial color="#292a30" />
  </mesh>
</group>
<group ref={rightLeg} position={[0.058, 0.2, 0.06]}>
  <mesh castShadow position={[0, -0.11, 0]}>
    <capsuleGeometry args={[0.036, style.legHeight, 4, 9]} />
    <meshStandardMaterial color={palette.bottom} />
  </mesh>
  <mesh castShadow position={[0, -0.25, 0.06]}>
    <boxGeometry args={[0.08, 0.04, 0.14]} />
    <meshStandardMaterial color="#292a30" />
  </mesh>
</group>

      <ActivityDiamond visible={emphasized || topic.live.status === 'running'} />
      <FloatingNameTag name={topic.configured.label} color={statusColor(topic.live.status)} position={[0.42, 1.42, 0.04]} visible={emphasized || topic.live.status !== 'idle'} />

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
        <ringGeometry args={[0.58, emphasized ? 0.92 : 0.76, 32]} />
        <meshBasicMaterial color={glow} transparent opacity={emphasized ? 0.32 : 0.18} />
      </mesh>

      <RoundedBox args={[1.52, 0.1, 0.74]} radius={0.03} smoothness={4} position={[-0.08, 0.5, -0.06]} castShadow receiveShadow>
        <meshStandardMaterial color="#ece7df" roughness={0.82} />
      </RoundedBox>
      <RoundedBox args={[0.76, 0.1, 1.18]} radius={0.03} smoothness={4} position={[0.46, 0.5, 0.16]} castShadow receiveShadow>
        <meshStandardMaterial color="#e9e3d9" roughness={0.82} />
      </RoundedBox>
      {[
        [-0.72, 0.24, -0.34],
        [0.38, 0.24, -0.34],
        [-0.72, 0.24, 0.2],
        [0.12, 0.24, 0.62],
        [0.82, 0.24, 0.62],
      ].map((leg, i) => (
        <mesh key={i} position={leg as [number, number, number]} castShadow>
          <boxGeometry args={[0.08, 0.48, 0.08]} />
          <meshStandardMaterial color="#8f8578" />
        </mesh>
      ))}

      <RoundedBox args={[0.54, 0.34, 0.08]} radius={0.02} smoothness={4} position={[-0.08, 0.82, -0.29]} castShadow ref={monitor as never}>
        <meshStandardMaterial color="#d7ddd9" emissive={glow} emissiveIntensity={glowStrength * 0.74} />
      </RoundedBox>
      <mesh position={[-0.08, 0.64, -0.29]} castShadow>
        <boxGeometry args={[0.06, 0.2, 0.06]} />
        <meshStandardMaterial color="#75808b" />
      </mesh>
      <RoundedBox args={[0.34, 0.26, 0.06]} radius={0.02} smoothness={4} position={[0.33, 0.77, -0.14]} castShadow>
        <meshStandardMaterial color="#c6ccc8" emissive={glow} emissiveIntensity={glowStrength * 0.4} />
      </RoundedBox>
      <mesh position={[0.33, 0.63, -0.14]} castShadow>
        <boxGeometry args={[0.05, 0.14, 0.05]} />
        <meshStandardMaterial color="#747d86" />
      </mesh>

      <mesh position={[-0.22, 0.56, -0.02]} castShadow>
        <boxGeometry args={[0.3, 0.03, 0.13]} />
        <meshStandardMaterial color="#d6d0c6" />
      </mesh>
      <mesh position={[0.05, 0.56, -0.02]} castShadow>
        <boxGeometry args={[0.24, 0.03, 0.13]} />
        <meshStandardMaterial color="#d6d0c6" />
      </mesh>
      <mesh position={[0.44, 0.57, 0.32]} castShadow>
        <cylinderGeometry args={[0.05, 0.05, 0.1, 16]} />
        <meshStandardMaterial color="#d7b77d" />
      </mesh>
      <mesh position={[0.58, 0.58, -0.08]} ref={lamp} castShadow rotation={[0, 0, -0.22]}>
        <cylinderGeometry args={[0.02, 0.03, 0.34, 16]} />
        <meshStandardMaterial color="#49515c" emissive={glow} emissiveIntensity={glowStrength * 0.14} />
      </mesh>
      <mesh position={[0.66, 0.73, -0.14]} castShadow>
        <coneGeometry args={[0.09, 0.18, 18]} />
        <meshStandardMaterial color="#f5f1e4" emissive="#f5f1e4" emissiveIntensity={0.22} />
      </mesh>

      <mesh position={[-0.56, 0.3, 0.12]} castShadow>
        <boxGeometry args={[0.3, 0.42, 0.48]} />
        <meshStandardMaterial color="#c9c0b3" />
      </mesh>
      {[0.18, 0.32].map((y, i) => (
        <mesh key={i} position={[-0.41, y, 0.36]} castShadow>
          <boxGeometry args={[0.02, 0.08, 0.2]} />
          <meshStandardMaterial color="#8f8578" />
        </mesh>
      ))}

      <RoundedBox args={[1.52, 0.46, 0.04]} radius={0.02} smoothness={4} position={[-0.08, 0.82, -0.43]} castShadow>
        <meshStandardMaterial color="#c8c6c0" />
      </RoundedBox>
      <RoundedBox args={[0.04, 0.46, 1.06]} radius={0.02} smoothness={4} position={[0.84, 0.82, 0.1]} castShadow>
        <meshStandardMaterial color="#c8c6c0" />
      </RoundedBox>

      <mesh position={[0.55, 0.58, 0.46]} castShadow>
        <boxGeometry args={[0.18, 0.04, 0.26]} />
        <meshStandardMaterial color="#c8b296" />
      </mesh>
    </>
  );
}

function ChairFallback({ glow, glowStrength }: { glow: THREE.Color; glowStrength: number }) {
  return (
    <>
      <mesh position={[0, 0.29, 0.03]} castShadow>
        <boxGeometry args={[0.42, 0.08, 0.4]} />
        <meshStandardMaterial color="#57657a" emissive={glow} emissiveIntensity={glowStrength * 0.08} />
      </mesh>
      <mesh position={[0, 0.56, 0.18]} castShadow>
        <boxGeometry args={[0.42, 0.46, 0.08]} />
        <meshStandardMaterial color="#667489" />
      </mesh>
      {[-0.18, 0.18].map((x, i) => (
        <mesh key={i} position={[x, 0.34, 0.02]} castShadow>
          <boxGeometry args={[0.05, 0.18, 0.24]} />
          <meshStandardMaterial color="#4d596b" />
        </mesh>
      ))}
      <mesh position={[0, 0.14, 0.02]} castShadow>
        <cylinderGeometry args={[0.05, 0.05, 0.28, 14]} />
        <meshStandardMaterial color="#5b554f" />
      </mesh>
      <mesh position={[0, 0.03, 0.02]} castShadow>
        <cylinderGeometry args={[0.16, 0.05, 0.04, 16]} />
        <meshStandardMaterial color="#403b37" />
      </mesh>
      {[
        [-0.16, 0.03, 0.17],
        [0.16, 0.03, 0.17],
        [-0.18, 0.03, -0.13],
        [0.18, 0.03, -0.13],
        [0, 0.03, -0.2],
      ].map((wheel, i) => (
        <mesh key={i} position={wheel as [number, number, number]} castShadow>
          <cylinderGeometry args={[0.03, 0.03, 0.04, 12]} />
          <meshStandardMaterial color="#202026" />
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

      <OfficeAssetSlot slot="deskChair" manifest={manifest} position={[0.16, 0.02, 0.78]} fallback={<ChairFallback glow={glow} glowStrength={glowStrength} />} />

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
      <RoundedBox args={[2.9, 0.16, 1.42]} radius={0.06} smoothness={4} position={[0, 0.08, 0]} castShadow>
        <meshStandardMaterial color="#edf2f6" />
      </RoundedBox>
      {[-1.15, 1.15].map((x, i) => (
        <mesh key={i} position={[x, 0.24, -0.42]} castShadow>
          <boxGeometry args={[0.16, 0.48, 0.16]} />
          <meshStandardMaterial color="#9f7753" />
        </mesh>
      ))}
      <mesh position={[0, 0.82, -0.24]} castShadow>
        <RoundedBox args={[0.92, 0.44, 0.08]} radius={0.02} smoothness={4}>
          <meshStandardMaterial color="#c8d3df" emissive="#7dffad" emissiveIntensity={0.08} />
        </RoundedBox>
      </mesh>
      <mesh position={[0, 0.62, -0.24]} castShadow>
        <boxGeometry args={[0.08, 0.38, 0.08]} />
        <meshStandardMaterial color="#64707d" />
      </mesh>
      <mesh position={[-0.72, 0.57, 0.12]} castShadow>
        <boxGeometry args={[0.42, 0.04, 0.22]} />
        <meshStandardMaterial color="#d8dde4" />
      </mesh>
      <mesh position={[0.72, 0.57, 0.12]} castShadow>
        <boxGeometry args={[0.42, 0.04, 0.22]} />
        <meshStandardMaterial color="#d8dde4" />
      </mesh>
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
  const centerSpacing = 1.04;

  return topics.map((topic, index) => {
    const side = index % 2;
    const row = Math.floor(index / 2);
    const jitter = ((hashLabel(topic.topicId) % 7) - 3) * 0.03;
    const x = side === 0 ? -4.3 : 4.3;
    const z = (row - (deskRows - 1) / 2) * 2.28 - 0.55 + jitter;
    const rotationY = Math.PI;
    const standbyX = (index - (topics.length - 1) / 2) * centerSpacing;
    const standbyZ = 1.0;
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

    const overviewTarget: [number, number, number] = [0, 1.0, 1.4];
    const desiredTarget = mode === 'focus' && focusTarget ? focusTarget : overviewTarget;
    const focusOffset: [number, number, number] = isMobile ? [6.2, 4.7, 7.2] : [7.4, 5.8, 8.6];
    const overviewOffset: [number, number, number] = isMobile ? [15.5, 11.0, 16.5] : [18.5, 13.2, 20.5];

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
            <div className="truncate text-[10px] uppercase tracking-[0.16em] text-white/65">{topic.configured.label}</div>
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
              <span className="truncate text-[11px] font-semibold" style={{ color }}>{topic.configured.label}</span>
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
            <div className="truncate text-sm font-semibold" style={{ color }}>{topic.configured.label}</div>
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
          <div className="truncate text-base font-semibold" style={{ color }}>{topic.configured.label}</div>
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
        camera={{ position: [18.5, 13.2, 20.5], fov: isMobile ? 44 : 38, near: 0.1, far: 180 }}
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
          minDistance={3.8}
          maxDistance={40}
          zoomSpeed={1.5}
          panSpeed={1.15}
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
