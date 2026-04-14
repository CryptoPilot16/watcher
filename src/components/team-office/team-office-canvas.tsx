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
      return 1.1;
    case 'idle':
      return 0.35;
    case 'missing':
      return 0.8;
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

type DeskLayout = {
  topic: TeamTopic;
  position: [number, number, number];
  statusNode: [number, number, number];
  walkTarget: [number, number, number];
  rotationY: number;
};

function buildNameTexture(name: string, accent: string) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(12, 12, 16, 0.92)';
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 2;
  const radius = 14;
  const x = 6;
  const y = 6;
  const w = canvas.width - 12;
  const h = canvas.height - 12;

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
  ctx.fillRect(14, 14, 10, h - 16);

  ctx.font = '600 34px Inter, Arial, sans-serif';
  ctx.fillStyle = '#f7f3eb';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 40, canvas.height / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function FloatingNameTag({ name, color, position }: { name: string; color: string; position: [number, number, number] }) {
  const texture = useMemo(() => buildNameTexture(name, color), [name, color]);
  if (!texture) return null;

  return (
    <sprite position={position} scale={[2.2, 0.66, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  );
}

function WorkerAvatar({ topic, origin, target, reducedMotion, seed }: {
  topic: TeamTopic;
  origin: [number, number, number];
  target: [number, number, number];
  reducedMotion: boolean;
  seed: number;
}) {
  const group = useRef<THREE.Group>(null);
  const leftArm = useRef<THREE.Mesh>(null);
  const rightArm = useRef<THREE.Mesh>(null);
  const color = useMemo(() => new THREE.Color(statusColor(topic.live.status)), [topic.live.status]);

  useFrame(({ clock }) => {
    if (!group.current) return;
    const t = clock.getElapsedTime() + seed * 0.29;
    const swing = Math.sin(t * 5.2) * 0.35;

    let x = origin[0];
    let z = origin[2];
    let facing = 0;
    if (topic.live.status === 'recent' && !reducedMotion) {
      const p = (Math.sin(t * 0.8) + 1) / 2;
      x = origin[0] + (target[0] - origin[0]) * p;
      z = origin[2] + (target[2] - origin[2]) * p;
      facing = Math.atan2(target[0] - origin[0], target[2] - origin[2]);
    } else {
      x = origin[0];
      z = origin[2];
      facing = Math.PI * 0.15;
    }

    group.current.position.set(x, 0.22 + (!reducedMotion ? Math.sin(t * 2.2) * 0.015 : 0), z);
    group.current.rotation.set(0, facing, 0);

    if (leftArm.current && rightArm.current) {
      if (topic.live.status === 'running' && !reducedMotion) {
        leftArm.current.rotation.x = -0.8 + swing * 0.25;
        rightArm.current.rotation.x = -0.4 - swing * 0.25;
      } else if (topic.live.status === 'recent' && !reducedMotion) {
        leftArm.current.rotation.x = swing;
        rightArm.current.rotation.x = -swing;
      } else {
        leftArm.current.rotation.x = -0.2;
        rightArm.current.rotation.x = 0.2;
      }
    }
  });

  if (topic.live.status === 'missing') {
    return (
      <group position={[origin[0], 0.2, origin[2]]}>
        <mesh>
          <cylinderGeometry args={[0.14, 0.18, 0.2, 16]} />
          <meshStandardMaterial color="#3a1515" emissive="#ff6b6b" emissiveIntensity={0.7} />
        </mesh>
      </group>
    );
  }

  return (
    <group ref={group}>
      <mesh position={[0, 0.24, 0]}>
        <boxGeometry args={[0.26, 0.36, 0.18]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={topic.live.status === 'running' ? 0.9 : 0.35} />
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
      <FloatingNameTag name={topic.configured.label} color={statusColor(topic.live.status)} position={[0, 1.15, 0]} />
    </group>
  );
}

function DeskUnit({ topic, position, rotationY, reducedMotion, walkTarget, seed }: {
  topic: TeamTopic;
  position: [number, number, number];
  rotationY: number;
  reducedMotion: boolean;
  walkTarget: [number, number, number];
  seed: number;
}) {
  const monitor = useRef<THREE.Mesh>(null);
  const lamp = useRef<THREE.Mesh>(null);
  const glow = useMemo(() => new THREE.Color(statusColor(topic.live.status)), [topic.live.status]);
  const glowStrength = statusGlow(topic.live.status);

  useFrame(({ clock }) => {
    if (reducedMotion) return;
    const t = clock.getElapsedTime() + seed * 0.2;
    if (monitor.current) {
      monitor.current.rotation.z = Math.sin(t * 0.7) * 0.01;
    }
    if (lamp.current) {
      lamp.current.scale.setScalar(1 + Math.sin(t * 2.3) * 0.06);
    }
  });

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh position={[0, 0.48, 0]}>
        <boxGeometry args={[1.5, 0.12, 0.95]} />
        <meshStandardMaterial color="#b47d4f" roughness={0.7} />
      </mesh>
      <mesh position={[-0.56, 0.23, -0.3]}>
        <boxGeometry args={[0.12, 0.46, 0.12]} />
        <meshStandardMaterial color="#8a5d39" />
      </mesh>
      <mesh position={[0.56, 0.23, -0.3]}>
        <boxGeometry args={[0.12, 0.46, 0.12]} />
        <meshStandardMaterial color="#8a5d39" />
      </mesh>
      <mesh position={[-0.56, 0.23, 0.3]}>
        <boxGeometry args={[0.12, 0.46, 0.12]} />
        <meshStandardMaterial color="#8a5d39" />
      </mesh>
      <mesh position={[0.56, 0.23, 0.3]}>
        <boxGeometry args={[0.12, 0.46, 0.12]} />
        <meshStandardMaterial color="#8a5d39" />
      </mesh>

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

      <group position={[0.52, 0.02, 0.68]}>
        <mesh position={[0, 0.25, 0]}>
          <boxGeometry args={[0.42, 0.08, 0.42]} />
          <meshStandardMaterial color="#556173" />
        </mesh>
        <mesh position={[0, 0.55, -0.14]}>
          <boxGeometry args={[0.42, 0.46, 0.08]} />
          <meshStandardMaterial color="#657285" />
        </mesh>
        <mesh position={[0, 0.13, 0]}>
          <cylinderGeometry args={[0.05, 0.05, 0.24, 14]} />
          <meshStandardMaterial color="#58524b" />
        </mesh>
      </group>

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <ringGeometry args={[0.56, 0.73, 32]} />
        <meshBasicMaterial color={glow} transparent opacity={topic.live.status === 'idle' ? 0.08 : 0.18} />
      </mesh>

      <WorkerAvatar
        topic={topic}
        origin={[0.05, 0, 0.4]}
        target={[walkTarget[0] - position[0], 0, walkTarget[2] - position[2]]}
        reducedMotion={reducedMotion}
        seed={seed}
      />
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
        <meshStandardMaterial color={glow} emissive={glow} emissiveIntensity={topic.live.status === 'idle' ? 0.1 : 0.45} transparent opacity={topic.live.status === 'missing' ? 0.08 : 0.25} />
      </mesh>
      {topic.live.status !== 'missing' && (
        <mesh ref={dot}>
          <sphereGeometry args={[0.08, 14, 14]} />
          <meshStandardMaterial color={glow} emissive={glow} emissiveIntensity={1.3} />
        </mesh>
      )}
    </>
  );
}

function Lounge() {
  return (
    <group position={[4.2, 0, -3.2]}>
      <mesh position={[0, 0.28, 0]}>
        <boxGeometry args={[1.4, 0.34, 0.7]} />
        <meshStandardMaterial color="#8f6bd2" />
      </mesh>
      <mesh position={[0, 0.66, -0.22]}>
        <boxGeometry args={[1.4, 0.44, 0.14]} />
        <meshStandardMaterial color="#7f5cc6" />
      </mesh>
      <mesh position={[-0.62, 0.58, 0]}>
        <boxGeometry args={[0.14, 0.42, 0.7]} />
        <meshStandardMaterial color="#7f5cc6" />
      </mesh>
      <mesh position={[0.62, 0.58, 0]}>
        <boxGeometry args={[0.14, 0.42, 0.7]} />
        <meshStandardMaterial color="#7f5cc6" />
      </mesh>
    </group>
  );
}

function MeetingTable() {
  return (
    <group position={[1.1, 0, -4.2]}>
      <mesh position={[0, 0.52, 0]}>
        <cylinderGeometry args={[1.7, 1.7, 0.16, 36]} />
        <meshStandardMaterial color="#d4a076" />
      </mesh>
      <mesh position={[0, 0.26, 0]}>
        <cylinderGeometry args={[0.16, 0.22, 0.52, 18]} />
        <meshStandardMaterial color="#99704b" />
      </mesh>
      {[
        [-1.6, 0, -0.2],
        [1.4, 0, -0.4],
        [-0.5, 0, 1.7],
        [0.9, 0, 1.5],
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

function WallScreens() {
  return (
    <>
      <mesh position={[-3.6, 1.8, -6.92]}>
        <boxGeometry args={[1.7, 0.9, 0.08]} />
        <meshStandardMaterial color="#16242c" emissive="#2d8fb0" emissiveIntensity={0.45} />
      </mesh>
      <mesh position={[4.8, 1.8, -6.92]}>
        <boxGeometry args={[1.1, 0.9, 0.08]} />
        <meshStandardMaterial color="#22314c" emissive="#7aa1ff" emissiveIntensity={0.35} />
      </mesh>
    </>
  );
}

function OfficeRoom({ topics, reducedMotion }: { topics: TeamTopic[]; reducedMotion: boolean }) {
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
        statusNode: [x + 0.7, 0.05, z - 0.2] as [number, number, number],
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
      <WallScreens />

      <mesh position={[5.8, 0.55, 0.4]}>
        <boxGeometry args={[0.35, 1.1, 0.35]} />
        <meshStandardMaterial color="#f5f7fa" />
      </mesh>
      <mesh position={[5.8, 1.2, 0.4]}>
        <cylinderGeometry args={[0.08, 0.08, 0.36, 16]} />
        <meshStandardMaterial color="#89d7b1" emissive="#89d7b1" emissiveIntensity={0.35} />
      </mesh>

      {deskLayouts.map((desk, index) => (
        <group key={desk.topic.topicId}>
          <DeskUnit
            topic={desk.topic}
            position={desk.position}
            rotationY={desk.rotationY}
            reducedMotion={reducedMotion}
            walkTarget={desk.walkTarget}
            seed={index + 1}
          />
          <RouteLine start={desk.statusNode} end={hub} topic={desk.topic} reducedMotion={reducedMotion} />
        </group>
      ))}
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

export function TeamOfficeCanvas({ topics }: { topics: TeamTopic[] }) {
  const [fallback, setFallback] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setReducedMotion(reduced);
    setFallback(reduced);
  }, []);

  if (fallback) return <FallbackOffice topics={topics} />;

  return (
    <div className="h-[390px] overflow-hidden rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.22)] sm:h-[620px]">
      <Canvas
        orthographic
        camera={{ position: [8.5, 10, 8.5], zoom: 58, near: 0.1, far: 100 }}
        dpr={typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, window.innerWidth < 768 ? 1.15 : 1.5)}
        onCreated={({ camera }) => {
          camera.lookAt(0, 0, -1.4);
        }}
      >
        <OfficeRoom topics={topics} reducedMotion={reducedMotion} />
      </Canvas>
    </div>
  );
}
