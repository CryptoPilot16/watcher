'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { TeamTaskSource, TeamTopic } from '@/lib/watch-team';

function statusColor(status: TeamTopic['live']['status']) {
  switch (status) {
    case 'running':
      return '#4fd5ff';
    case 'recent':
      return '#f6bf4f';
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
      return 1.8;
    case 'recent':
      return 1.15;
    case 'idle':
      return 0.35;
    case 'missing':
      return 0.85;
    default:
      return 0.4;
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
  if (topic.live.status === 'recent') return 'moving';
  if (topic.live.status === 'missing') return 'offline';
  return 'idle';
}

function topicHeadline(topic: TeamTopic) {
  return topic.currentTask.snippet || topic.recent.lastAssistantText || topic.recent.lastUserText || topic.live.freshnessLabel || 'Waiting for work';
}

type DeskLayout = {
  topic: TeamTopic;
  position: [number, number, number];
  routeStart: [number, number, number];
  walkTarget: [number, number, number];
  rotationY: number;
};

function buildNameTexture(name: string, accent: string) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 92;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(14, 14, 20, 0.94)';
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 2;

  const x = 6;
  const y = 6;
  const w = canvas.width - 12;
  const h = canvas.height - 12;
  const radius = 16;

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
  ctx.fillRect(16, 14, 11, h - 16);

  ctx.font = '600 34px Inter, Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f7f3eb';
  ctx.fillText(name, 42, canvas.height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function FloatingNameTag({ name, color, position, visible = true }: { name: string; color: string; position: [number, number, number]; visible?: boolean }) {
  const texture = useMemo(() => buildNameTexture(name, color), [name, color]);
  if (!texture || !visible) return null;

  return (
    <sprite position={position} scale={[2.35, 0.62, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  );
}

function Plumbob({ visible }: { visible: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!mesh.current || !visible) return;
    const t = clock.getElapsedTime();
    mesh.current.rotation.y = t * 1.2;
    mesh.current.position.y = 1.52 + Math.sin(t * 2) * 0.06;
  });

  if (!visible) return null;

  return (
    <mesh ref={mesh} position={[0, 1.52, 0]}>
      <octahedronGeometry args={[0.16, 0]} />
      <meshStandardMaterial color="#73ff9f" emissive="#73ff9f" emissiveIntensity={1.45} />
    </mesh>
  );
}

function WorkerAvatar({ topic, localOrigin, localTarget, reducedMotion, seed, emphasized }: {
  topic: TeamTopic;
  localOrigin: [number, number, number];
  localTarget: [number, number, number];
  reducedMotion: boolean;
  seed: number;
  emphasized: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const leftArm = useRef<THREE.Mesh>(null);
  const rightArm = useRef<THREE.Mesh>(null);
  const color = useMemo(() => new THREE.Color(statusColor(topic.live.status)), [topic.live.status]);

  useFrame(({ clock }) => {
    if (!group.current) return;
    const t = clock.getElapsedTime() + seed * 0.31;
    const swing = Math.sin(t * 5.1) * 0.34;

    let x = localOrigin[0];
    let z = localOrigin[2];
    let facing = Math.PI * 0.08;

    if (topic.live.status === 'recent' && !reducedMotion) {
      const p = (Math.sin(t * 0.78) + 1) / 2;
      x = localOrigin[0] + (localTarget[0] - localOrigin[0]) * p;
      z = localOrigin[2] + (localTarget[2] - localOrigin[2]) * p;
      facing = Math.atan2(localTarget[0] - localOrigin[0], localTarget[2] - localOrigin[2]);
    }

    group.current.position.set(x, 0.24 + (!reducedMotion ? Math.sin(t * 2.2) * 0.015 : 0), z);
    group.current.rotation.set(0, facing, 0);

    if (leftArm.current && rightArm.current) {
      if (topic.live.status === 'running' && !reducedMotion) {
        leftArm.current.rotation.x = -0.82 + swing * 0.22;
        rightArm.current.rotation.x = -0.42 - swing * 0.22;
      } else if (topic.live.status === 'recent' && !reducedMotion) {
        leftArm.current.rotation.x = swing;
        rightArm.current.rotation.x = -swing;
      } else {
        leftArm.current.rotation.x = -0.18;
        rightArm.current.rotation.x = 0.18;
      }
    }
  });

  if (topic.live.status === 'missing') {
    return (
      <group position={[localOrigin[0], 0.2, localOrigin[2]]}>
        <mesh>
          <cylinderGeometry args={[0.14, 0.18, 0.2, 16]} />
          <meshStandardMaterial color="#3a1515" emissive="#ff6b6b" emissiveIntensity={0.72} />
        </mesh>
      </group>
    );
  }

  return (
    <group ref={group}>
      <mesh position={[0, 0.24, 0]}>
        <boxGeometry args={[0.26, 0.36, 0.18]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={topic.live.status === 'running' ? 0.92 : 0.34} />
      </mesh>
      <mesh position={[0, 0.56, 0]}>
        <boxGeometry args={[0.18, 0.18, 0.18]} />
        <meshStandardMaterial color="#f1d3b0" />
      </mesh>
      <mesh ref={leftArm} position={[-0.18, 0.25, 0]}>
        <boxGeometry args={[0.08, 0.26, 0.08]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.3} />
      </mesh>
      <mesh ref={rightArm} position={[0.18, 0.25, 0]}>
        <boxGeometry args={[0.08, 0.26, 0.08]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.3} />
      </mesh>
      <mesh position={[-0.08, -0.06, 0]}>
        <boxGeometry args={[0.08, 0.26, 0.08]} />
        <meshStandardMaterial color="#2a241e" />
      </mesh>
      <mesh position={[0.08, -0.06, 0]}>
        <boxGeometry args={[0.08, 0.26, 0.08]} />
        <meshStandardMaterial color="#2a241e" />
      </mesh>
      <Plumbob visible={emphasized || topic.live.status === 'running'} />
      <FloatingNameTag name={topic.configured.label} color={statusColor(topic.live.status)} position={[0, 1.16, 0]} visible={emphasized || topic.live.status !== 'idle'} />
    </group>
  );
}

function DeskUnit({ topic, position, rotationY, reducedMotion, walkTarget, seed, emphasized, onHover, onLeave, onSelect }: {
  topic: TeamTopic;
  position: [number, number, number];
  rotationY: number;
  reducedMotion: boolean;
  walkTarget: [number, number, number];
  seed: number;
  emphasized: boolean;
  onHover: () => void;
  onLeave: () => void;
  onSelect: () => void;
}) {
  const monitor = useRef<THREE.Mesh>(null);
  const lamp = useRef<THREE.Mesh>(null);
  const glow = useMemo(() => new THREE.Color(statusColor(topic.live.status)), [topic.live.status]);
  const glowStrength = statusGlow(topic.live.status);

  useFrame(({ clock }) => {
    if (reducedMotion) return;
    const t = clock.getElapsedTime() + seed * 0.2;
    if (monitor.current) monitor.current.rotation.z = Math.sin(t * 0.7) * 0.01;
    if (lamp.current) lamp.current.scale.setScalar(1 + Math.sin(t * 2.3) * 0.06);
  });

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <ringGeometry args={[0.56, emphasized ? 0.86 : 0.73, 32]} />
        <meshBasicMaterial color={glow} transparent opacity={topic.live.status === 'idle' ? 0.08 : emphasized ? 0.28 : 0.18} />
      </mesh>

      <mesh position={[0, 0.48, 0]}>
        <boxGeometry args={[1.5, 0.12, 0.95]} />
        <meshStandardMaterial color="#b47d4f" roughness={0.7} />
      </mesh>
      {[
        [-0.56, 0.23, -0.3],
        [0.56, 0.23, -0.3],
        [-0.56, 0.23, 0.3],
        [0.56, 0.23, 0.3],
      ].map((leg, i) => (
        <mesh key={i} position={leg as [number, number, number]}>
          <boxGeometry args={[0.12, 0.46, 0.12]} />
          <meshStandardMaterial color="#8a5d39" />
        </mesh>
      ))}

      <mesh position={[0.02, 0.82, -0.2]} ref={monitor}>
        <boxGeometry args={[0.54, 0.34, 0.06]} />
        <meshStandardMaterial color="#2c3440" emissive={glow} emissiveIntensity={glowStrength} />
      </mesh>
      <mesh position={[0.02, 0.62, -0.2]}>
        <boxGeometry args={[0.06, 0.2, 0.06]} />
        <meshStandardMaterial color="#6f7a83" />
      </mesh>
      <mesh position={[-0.26, 0.56, 0.02]}>
        <boxGeometry args={[0.18, 0.03, 0.12]} />
        <meshStandardMaterial color="#d8dbe0" />
      </mesh>
      <mesh position={[-0.01, 0.56, 0.02]}>
        <boxGeometry args={[0.22, 0.03, 0.12]} />
        <meshStandardMaterial color="#d8dbe0" />
      </mesh>
      <mesh position={[0.43, 0.6, 0.12]} ref={lamp}>
        <cylinderGeometry args={[0.05, 0.05, 0.16, 16]} />
        <meshStandardMaterial color={glow} emissive={glow} emissiveIntensity={glowStrength * 1.3} />
      </mesh>

      <mesh position={[0, 0.84, 0.34]}>
        <boxGeometry args={[1.35, 0.42, 0.06]} />
        <meshStandardMaterial color="#2b2727" />
      </mesh>
      <mesh position={[-0.66, 0.84, 0]}>
        <boxGeometry args={[0.06, 0.42, 0.72]} />
        <meshStandardMaterial color="#2b2727" />
      </mesh>

      <group position={[0.52, 0.02, 0.68]}>
        <mesh position={[0, 0.25, 0]}>
          <boxGeometry args={[0.42, 0.08, 0.42]} />
          <meshStandardMaterial color="#556173" />
        </mesh>
        <mesh position={[0, 0.55, -0.14]}>
          <boxGeometry args={[0.42, 0.46, 0.08]} />
          <meshStandardMaterial color="#657285" />
        </mesh>
        <mesh position={[0, 0.12, 0]}>
          <cylinderGeometry args={[0.05, 0.05, 0.24, 14]} />
          <meshStandardMaterial color="#58524b" />
        </mesh>
        {[-0.12, 0.12].map((x, i) => (
          <mesh key={i} position={[x, 0.02, -0.12]}>
            <cylinderGeometry args={[0.03, 0.03, 0.04, 12]} />
            <meshStandardMaterial color="#1f1f22" />
          </mesh>
        ))}
      </group>

      <WorkerAvatar
        topic={topic}
        localOrigin={[0.05, 0, 0.4]}
        localTarget={[walkTarget[0] - position[0], 0, walkTarget[2] - position[2]]}
        reducedMotion={reducedMotion}
        seed={seed}
        emphasized={emphasized}
      />

      <mesh
        position={[0, 0.6, 0.15]}
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
        <boxGeometry args={[1.8, 1.6, 1.5]} />
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
    const mid = new THREE.Vector3((start[0] + end[0]) / 2, 0.18, (start[2] + end[2]) / 2);
    return new THREE.QuadraticBezierCurve3(new THREE.Vector3(...start), mid, new THREE.Vector3(...end));
  }, [start, end]);
  const geometry = useMemo(() => new THREE.TubeGeometry(curve, 28, 0.024, 10, false), [curve]);
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
        <meshStandardMaterial color={glow} emissive={glow} emissiveIntensity={topic.live.status === 'idle' ? 0.08 : 0.42} transparent opacity={topic.live.status === 'missing' ? 0.08 : 0.24} />
      </mesh>
      {topic.live.status !== 'missing' && (
        <mesh ref={dot}>
          <sphereGeometry args={[0.075, 14, 14]} />
          <meshStandardMaterial color={glow} emissive={glow} emissiveIntensity={1.25} />
        </mesh>
      )}
    </>
  );
}

function Lounge() {
  return (
    <group position={[4.25, 0, -3.1]}>
      <mesh position={[0, 0.28, 0]}>
        <boxGeometry args={[1.45, 0.34, 0.72]} />
        <meshStandardMaterial color="#8f6bd2" />
      </mesh>
      <mesh position={[0, 0.66, -0.22]}>
        <boxGeometry args={[1.45, 0.44, 0.14]} />
        <meshStandardMaterial color="#7f5cc6" />
      </mesh>
      <mesh position={[-0.65, 0.58, 0]}>
        <boxGeometry args={[0.14, 0.42, 0.72]} />
        <meshStandardMaterial color="#7f5cc6" />
      </mesh>
      <mesh position={[0.65, 0.58, 0]}>
        <boxGeometry args={[0.14, 0.42, 0.72]} />
        <meshStandardMaterial color="#7f5cc6" />
      </mesh>
    </group>
  );
}

function MeetingTable() {
  return (
    <group position={[1.2, 0, -4.1]}>
      <mesh position={[0, 0.52, 0]}>
        <cylinderGeometry args={[1.75, 1.75, 0.16, 36]} />
        <meshStandardMaterial color="#d4a076" />
      </mesh>
      <mesh position={[0, 0.26, 0]}>
        <cylinderGeometry args={[0.16, 0.22, 0.52, 18]} />
        <meshStandardMaterial color="#99704b" />
      </mesh>
      {[
        [-1.62, 0, -0.15],
        [1.42, 0, -0.36],
        [-0.54, 0, 1.74],
        [0.92, 0, 1.56],
      ].map((pos, i) => (
        <group key={i} position={pos as [number, number, number]}>
          <mesh position={[0, 0.22, 0]}>
            <boxGeometry args={[0.34, 0.08, 0.34]} />
            <meshStandardMaterial color="#637289" />
          </mesh>
          <mesh position={[0, 0.5, -0.1]}>
            <boxGeometry args={[0.34, 0.44, 0.08]} />
            <meshStandardMaterial color="#73829b" />
          </mesh>
          <mesh position={[0, 0.12, 0]}>
            <cylinderGeometry args={[0.04, 0.04, 0.24, 12]} />
            <meshStandardMaterial color="#55514b" />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function WindowsAndDecor() {
  return (
    <>
      {[-3.7, 0.1, 3.9].map((x, i) => (
        <group key={i} position={[x, 1.85, -6.9]}>
          <mesh>
            <boxGeometry args={[1.7, 1.7, 0.06]} />
            <meshStandardMaterial color="#212229" />
          </mesh>
          <mesh position={[0, 0, -0.01]}>
            <boxGeometry args={[1.4, 1.45, 0.02]} />
            <meshStandardMaterial color="#dbeffc" emissive="#dbeffc" emissiveIntensity={0.18} />
          </mesh>
          <mesh position={[0, 0, 0.02]}>
            <boxGeometry args={[0.06, 1.45, 0.04]} />
            <meshStandardMaterial color="#1f1f23" />
          </mesh>
          <mesh position={[0, 0, 0.02]} rotation={[0, 0, Math.PI / 2]}>
            <boxGeometry args={[0.06, 1.45, 0.04]} />
            <meshStandardMaterial color="#1f1f23" />
          </mesh>
        </group>
      ))}

      <mesh position={[-5.2, 1.75, -6.87]}>
        <boxGeometry args={[1.4, 1.1, 0.06]} />
        <meshStandardMaterial color="#d3b78f" />
      </mesh>
      {[
        [-5.55, 2.05],
        [-5.1, 2.05],
        [-4.65, 2.05],
        [-5.55, 1.65],
        [-5.1, 1.65],
        [-4.65, 1.65],
      ].map((pin, i) => (
        <mesh key={i} position={[pin[0], pin[1], -6.82]}>
          <boxGeometry args={[0.26, 0.18, 0.02]} />
          <meshStandardMaterial color={i % 2 === 0 ? '#ffe38d' : '#f9c1a5'} />
        </mesh>
      ))}
    </>
  );
}

function OfficeRoom({ topics, reducedMotion, hoveredTopicId, selectedTopicId, onHover, onLeave, onSelect }: {
  topics: TeamTopic[];
  reducedMotion: boolean;
  hoveredTopicId: string | null;
  selectedTopicId: string | null;
  onHover: (topicId: string) => void;
  onLeave: (topicId: string) => void;
  onSelect: (topicId: string) => void;
}) {
  const hub: [number, number, number] = [0.2, 0.06, -0.8];
  const deskLayouts = useMemo<DeskLayout[]>(() => {
    const rows = Math.ceil(topics.length / 2);
    const gapZ = rows > 1 ? 2.6 : 0;
    return topics.map((topic, index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = col === 0 ? -3.5 : 2.8;
      const z = (row - (rows - 1) / 2) * gapZ + 0.8;
      return {
        topic,
        position: [x, 0, z] as [number, number, number],
        routeStart: [x + 0.7, 0.05, z - 0.2] as [number, number, number],
        walkTarget: [col === 0 ? -1.3 : 1.5, 0, z - 0.25] as [number, number, number],
        rotationY: col === 0 ? Math.PI * 0.02 : -Math.PI * 0.04,
      };
    });
  }, [topics]);

  return (
    <>
      <color attach="background" args={['#2b160f']} />
      <fog attach="fog" args={['#2b160f', 13, 24]} />
      <ambientLight intensity={1.15} color="#fff0d0" />
      <hemisphereLight args={['#fff4d8', '#8c6246', 1.25]} />
      <directionalLight position={[6, 10, 5]} intensity={1.7} color="#fff1ca" />
      <pointLight position={[0, 7, -2]} intensity={18} color="#ffd4a6" />
      <pointLight position={[5.5, 5, -4]} intensity={6} color="#a072ff" />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[16, 14]} />
        <meshStandardMaterial color="#f3ead7" roughness={0.95} />
      </mesh>
      <mesh position={[0, 1.45, -6.95]}>
        <boxGeometry args={[16, 2.9, 0.18]} />
        <meshStandardMaterial color="#a7a7ad" />
      </mesh>
      <mesh position={[-7.92, 1.45, 0]}>
        <boxGeometry args={[0.18, 2.9, 14]} />
        <meshStandardMaterial color="#8f8f95" />
      </mesh>
      <mesh position={[7.92, 1.45, 0]}>
        <boxGeometry args={[0.18, 2.9, 14]} />
        <meshStandardMaterial color="#8f8f95" />
      </mesh>

      <mesh position={[0.2, 0.02, -0.8]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[2.15, 40]} />
        <meshBasicMaterial color="#d9ad84" />
      </mesh>

      <MeetingTable />
      <Lounge />
      <WindowsAndDecor />

      <mesh position={[5.8, 0.55, 0.4]}>
        <boxGeometry args={[0.35, 1.1, 0.35]} />
        <meshStandardMaterial color="#f5f7fa" />
      </mesh>
      <mesh position={[5.8, 1.2, 0.4]}>
        <cylinderGeometry args={[0.08, 0.08, 0.36, 16]} />
        <meshStandardMaterial color="#89d7b1" emissive="#89d7b1" emissiveIntensity={0.35} />
      </mesh>

      {deskLayouts.map((desk, index) => {
        const emphasized = hoveredTopicId === desk.topic.topicId || selectedTopicId === desk.topic.topicId;
        return (
          <group key={desk.topic.topicId}>
            <DeskUnit
              topic={desk.topic}
              position={desk.position}
              rotationY={desk.rotationY}
              reducedMotion={reducedMotion}
              walkTarget={desk.walkTarget}
              seed={index + 1}
              emphasized={emphasized}
              onHover={() => onHover(desk.topic.topicId)}
              onLeave={() => onLeave(desk.topic.topicId)}
              onSelect={() => onSelect(desk.topic.topicId)}
            />
            <RouteLine start={desk.routeStart} end={hub} topic={desk.topic} reducedMotion={reducedMotion} />
          </group>
        );
      })}
    </>
  );
}

function FallbackOffice({ topics }: { topics: TeamTopic[] }) {
  return (
    <div className="relative h-[380px] overflow-hidden rounded-xl border border-[var(--watch-panel-border)] bg-[linear-gradient(180deg,#2a160f,#130d0a)] sm:h-[560px]">
      <div className="absolute inset-6 rounded-xl bg-[#f3ead7]" />
      <div className="absolute left-1/2 top-20 h-28 w-28 -translate-x-1/2 rounded-full bg-[#d9ad84] opacity-90" />
      <div className="absolute right-12 top-28 h-16 w-20 rounded bg-[#8f6bd2]" />
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

function TopicInfoCard({ topic }: { topic: TeamTopic | null }) {
  if (!topic) return null;
  const color = statusColor(topic.live.status);
  return (
    <div className="pointer-events-none absolute right-3 top-3 w-[220px] rounded-xl border border-white/10 bg-[rgba(10,10,14,0.88)] p-3 text-white shadow-2xl backdrop-blur-md sm:w-[260px]">
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

export function TeamOfficeCanvas({ topics }: { topics: TeamTopic[] }) {
  const [fallback, setFallback] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [hoveredTopicId, setHoveredTopicId] = useState<string | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);

  useEffect(() => {
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setReducedMotion(reduced);
    setFallback(reduced);
  }, []);

  const defaultTopic = topics.find((topic) => topic.live.status === 'running') || topics.find((topic) => topic.live.status === 'recent') || topics[0] || null;
  const activeTopic = topics.find((topic) => topic.topicId === hoveredTopicId)
    || topics.find((topic) => topic.topicId === selectedTopicId)
    || defaultTopic;

  if (fallback) return <FallbackOffice topics={topics} />;

  return (
    <div className="relative h-[390px] overflow-hidden rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.22)] sm:h-[620px]">
      <Canvas
        orthographic
        camera={{ position: [8.5, 10, 8.5], zoom: 58, near: 0.1, far: 100 }}
        dpr={typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, window.innerWidth < 768 ? 1.15 : 1.5)}
        onCreated={({ camera }) => {
          camera.lookAt(0, 0, -1.4);
        }}
        onPointerMissed={() => setSelectedTopicId(null)}
      >
        <OfficeRoom
          topics={topics}
          reducedMotion={reducedMotion}
          hoveredTopicId={hoveredTopicId}
          selectedTopicId={selectedTopicId}
          onHover={setHoveredTopicId}
          onLeave={(topicId) => {
            setHoveredTopicId((current) => (current === topicId ? null : current));
          }}
          onSelect={setSelectedTopicId}
        />
      </Canvas>

      <TopicInfoCard topic={activeTopic} />

      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-2">
        <div className="rounded-md bg-[rgba(10,10,14,0.84)] px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-white/70 shadow-lg">hover or tap a worker</div>
        <div className="rounded-md bg-[rgba(10,10,14,0.84)] px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-white/70 shadow-lg">green diamond = active sim</div>
      </div>
    </div>
  );
}
