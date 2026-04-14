'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { TeamTaskSource, TeamTopic } from '@/lib/watch-team';

function statusColor(status: TeamTopic['live']['status']) {
  switch (status) {
    case 'running':
      return '#67e8f9';
    case 'recent':
      return '#fbbf24';
    case 'idle':
      return '#8f7a53';
    case 'missing':
      return '#f87171';
    default:
      return '#d4ba68';
  }
}

function statusIntensity(status: TeamTopic['live']['status']) {
  switch (status) {
    case 'running':
      return 2.2;
    case 'recent':
      return 1.4;
    case 'idle':
      return 0.55;
    case 'missing':
      return 0.95;
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
      return 'user ping';
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

function confidenceColor(confidence: TeamTopic['currentTask']['confidence']) {
  switch (confidence) {
    case 'high':
      return '#67e8f9';
    case 'medium':
      return '#fbbf24';
    default:
      return '#8f7a53';
  }
}

type DeskLayout = {
  topic: TeamTopic;
  position: [number, number, number];
  rotationY: number;
  side: 'left' | 'right';
  laneStart: [number, number, number];
};

function laneCurve(start: [number, number, number], end: [number, number, number], lift = 0.12) {
  const midX = (start[0] + end[0]) / 2;
  const midZ = (start[2] + end[2]) / 2;
  return new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(...start),
    new THREE.Vector3(midX, Math.max(start[1], end[1]) + lift, midZ),
    new THREE.Vector3(...end),
  );
}

function Avatar({ topic, deskPosition, hubPosition, reducedMotion, seed }: {
  topic: TeamTopic;
  deskPosition: [number, number, number];
  hubPosition: [number, number, number];
  reducedMotion: boolean;
  seed: number;
}) {
  const group = useRef<THREE.Group>(null);
  const leftArm = useRef<THREE.Mesh>(null);
  const rightArm = useRef<THREE.Mesh>(null);
  const color = useMemo(() => new THREE.Color(statusColor(topic.live.status)), [topic.live.status]);
  const lane = useMemo(() => laneCurve(deskPosition, hubPosition, 0.4), [deskPosition, hubPosition]);

  useFrame(({ clock }) => {
    if (!group.current) return;

    const t = clock.getElapsedTime() + seed * 0.37;
    const baseY = 0.2;
    const walkCycle = Math.sin(t * 5.4) * 0.22;

    if (topic.live.status === 'recent' && !reducedMotion) {
      const progress = (Math.sin(t * 0.9) + 1) / 2;
      const point = lane.getPoint(progress);
      const nextPoint = lane.getPoint(Math.min(progress + 0.02, 1));
      group.current.position.set(point.x, point.y + baseY, point.z);
      group.current.lookAt(nextPoint.x, point.y + baseY, nextPoint.z);
      group.current.rotation.x = 0;
      group.current.rotation.z = 0;
    } else {
      group.current.position.set(deskPosition[0], baseY, deskPosition[2] + 0.15);
      group.current.rotation.set(0, topic.live.status === 'running' ? Math.PI : Math.PI * 0.95, 0);
      if (!reducedMotion) {
        group.current.position.y = baseY + (topic.live.status === 'running' ? Math.sin(t * 2.1) * 0.03 : Math.sin(t * 1.1) * 0.015);
      }
    }

    if (leftArm.current && rightArm.current) {
      if (topic.live.status === 'running' && !reducedMotion) {
        leftArm.current.rotation.x = -0.8 + walkCycle * 0.35;
        rightArm.current.rotation.x = -0.8 - walkCycle * 0.35;
      } else if (topic.live.status === 'recent' && !reducedMotion) {
        leftArm.current.rotation.x = walkCycle;
        rightArm.current.rotation.x = -walkCycle;
      } else {
        leftArm.current.rotation.x = -0.2;
        rightArm.current.rotation.x = 0.2;
      }
    }
  });

  if (topic.live.status === 'missing') {
    return (
      <group position={[deskPosition[0], 0.25, deskPosition[2] + 0.12]}>
        <mesh>
          <cylinderGeometry args={[0.11, 0.16, 0.18, 16]} />
          <meshStandardMaterial color="#2a1111" emissive="#f87171" emissiveIntensity={0.55} transparent opacity={0.66} />
        </mesh>
      </group>
    );
  }

  return (
    <group ref={group}>
      <mesh position={[0, 0.38, 0]}>
        <capsuleGeometry args={[0.12, 0.38, 4, 10]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={topic.live.status === 'running' ? 1.2 : 0.55} />
      </mesh>
      <mesh position={[0, 0.72, 0]}>
        <sphereGeometry args={[0.11, 18, 18]} />
        <meshStandardMaterial color="#f3dfb3" emissive="#f3dfb3" emissiveIntensity={0.2} />
      </mesh>
      <mesh ref={leftArm} position={[-0.15, 0.43, 0]}>
        <capsuleGeometry args={[0.035, 0.2, 4, 8]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.45} />
      </mesh>
      <mesh ref={rightArm} position={[0.15, 0.43, 0]}>
        <capsuleGeometry args={[0.035, 0.2, 4, 8]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.45} />
      </mesh>
      <mesh position={[-0.06, 0.05, 0]}>
        <capsuleGeometry args={[0.03, 0.18, 4, 8]} />
        <meshStandardMaterial color="#2c2217" />
      </mesh>
      <mesh position={[0.06, 0.05, 0]}>
        <capsuleGeometry args={[0.03, 0.18, 4, 8]} />
        <meshStandardMaterial color="#2c2217" />
      </mesh>
    </group>
  );
}

function DeskCluster({ topic, position, rotationY, reducedMotion, side, hubPosition, seed }: {
  topic: TeamTopic;
  position: [number, number, number];
  rotationY: number;
  reducedMotion: boolean;
  side: 'left' | 'right';
  hubPosition: [number, number, number];
  seed: number;
}) {
  const monitor = useRef<THREE.Mesh>(null);
  const beacon = useRef<THREE.Mesh>(null);
  const deskAura = useRef<THREE.Mesh>(null);
  const color = useMemo(() => new THREE.Color(statusColor(topic.live.status)), [topic.live.status]);
  const intensity = statusIntensity(topic.live.status);

  useFrame(({ clock }) => {
    if (reducedMotion) return;
    const t = clock.getElapsedTime() + seed * 0.23;
    const pulse = 1 + Math.sin(t * (topic.live.status === 'running' ? 3.2 : 1.6)) * 0.08;
    if (beacon.current) {
      beacon.current.scale.setScalar(pulse);
      beacon.current.position.y = 1.06 + (pulse - 1) * 0.15;
    }
    if (monitor.current) {
      monitor.current.rotation.z = Math.sin(t * 0.9) * 0.015;
    }
    if (deskAura.current) {
      deskAura.current.scale.set(1 + (pulse - 1) * 0.9, 1, 1 + (pulse - 1) * 0.9);
    }
  });

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh position={[0, 0.03, 0]} ref={deskAura} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.62, 0.86, 40]} />
        <meshBasicMaterial color={color} transparent opacity={topic.live.status === 'idle' ? 0.12 : 0.22} />
      </mesh>

      <mesh position={[0, 0.18, 0]}>
        <boxGeometry args={[1.85, 0.16, 1.15]} />
        <meshStandardMaterial color="#231a12" metalness={0.35} roughness={0.72} />
      </mesh>
      <mesh position={[0, 0.08, 0]}>
        <boxGeometry args={[1.25, 0.06, 0.52]} />
        <meshStandardMaterial color="#17120d" />
      </mesh>
      <mesh position={[0, 0.76, -0.24]} ref={monitor}>
        <boxGeometry args={[0.92, 0.56, 0.08]} />
        <meshStandardMaterial color="#0d1117" emissive={color} emissiveIntensity={intensity} />
      </mesh>
      <mesh position={[0, 0.76, -0.285]}>
        <boxGeometry args={[0.74, 0.4, 0.03]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={intensity * 1.45} transparent opacity={0.72} />
      </mesh>
      <mesh position={[0, 0.48, -0.22]}>
        <boxGeometry args={[0.08, 0.36, 0.08]} />
        <meshStandardMaterial color="#403320" />
      </mesh>
      <mesh position={[0.62, 0.28, 0.24]} ref={beacon}>
        <sphereGeometry args={[0.1, 18, 18]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={intensity * 2.2} />
      </mesh>
      <mesh position={[-0.62, 0.45, 0.1]}>
        <boxGeometry args={[0.16, 0.52, 0.16]} />
        <meshStandardMaterial color={side === 'left' ? '#4c6a76' : '#6c5c2c'} emissive={side === 'left' ? '#67e8f9' : '#d4ba68'} emissiveIntensity={0.25} />
      </mesh>
      <mesh position={[0, 0.3, 0.48]}>
        <boxGeometry args={[0.74, 0.1, 0.54]} />
        <meshStandardMaterial color="#261d15" />
      </mesh>
      <mesh position={[0, 0.6, 0.54]}>
        <boxGeometry args={[0.64, 0.56, 0.08]} />
        <meshStandardMaterial color="#1c140f" />
      </mesh>
      <Avatar topic={topic} deskPosition={[0, 0, 0.05]} hubPosition={[hubPosition[0] - position[0], hubPosition[1], hubPosition[2] - position[2]]} reducedMotion={reducedMotion} seed={seed} />
    </group>
  );
}

function Hub({ activeCount, reducedMotion }: { activeCount: number; reducedMotion: boolean }) {
  const ring = useRef<THREE.Mesh>(null);
  const core = useRef<THREE.Mesh>(null);
  const holo = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (reducedMotion) return;
    const t = clock.getElapsedTime();
    if (ring.current) ring.current.rotation.y = t * 0.55;
    if (core.current) core.current.rotation.y = -t * 0.28;
    if (holo.current) {
      holo.current.rotation.z = Math.sin(t * 1.8) * 0.14;
      holo.current.position.y = 1.52 + Math.sin(t * 2.1) * 0.05;
    }
  });

  return (
    <group position={[0, 0, 0]}>
      <mesh position={[0, 0.18, 0]}>
        <cylinderGeometry args={[1.5, 1.9, 0.28, 8]} />
        <meshStandardMaterial color="#241b12" metalness={0.46} roughness={0.42} />
      </mesh>
      <mesh position={[0, 0.48, 0]}>
        <cylinderGeometry args={[0.82, 0.92, 0.44, 24]} />
        <meshStandardMaterial color="#0f1720" emissive="#67e8f9" emissiveIntensity={1} transparent opacity={0.86} />
      </mesh>
      <mesh ref={core} position={[0, 1.02, 0]}>
        <cylinderGeometry args={[0.18, 0.18, 1.2, 20]} />
        <meshStandardMaterial color="#a2f2ff" emissive="#67e8f9" emissiveIntensity={2.4 + Math.min(activeCount, 6) * 0.18} transparent opacity={0.92} />
      </mesh>
      <mesh ref={ring} position={[0, 1.48, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.94, 0.05, 18, 64]} />
        <meshStandardMaterial color="#ecd58d" emissive="#ecd58d" emissiveIntensity={1.6} />
      </mesh>
      <mesh ref={holo} position={[0, 1.54, 0]} rotation={[Math.PI / 2, 0, 0.2]}>
        <torusGeometry args={[0.62, 0.03, 12, 48]} />
        <meshStandardMaterial color="#67e8f9" emissive="#67e8f9" emissiveIntensity={1.8} transparent opacity={0.85} />
      </mesh>
    </group>
  );
}

function ActivityLane({ start, end, topic, reducedMotion }: {
  start: [number, number, number];
  end: [number, number, number];
  topic: TeamTopic;
  reducedMotion: boolean;
}) {
  const trail = useRef<THREE.Mesh>(null);
  const color = useMemo(() => new THREE.Color(statusColor(topic.live.status)), [topic.live.status]);
  const curve = useMemo(() => laneCurve(start, end, 0.18), [start, end]);
  const geometry = useMemo(() => new THREE.TubeGeometry(curve, 40, 0.025, 8, false), [curve]);

  useFrame(({ clock }) => {
    if (reducedMotion || !trail.current) return;
    const t = clock.getElapsedTime();
    const progress = topic.live.status === 'running'
      ? (t * 0.22) % 1
      : topic.live.status === 'recent'
        ? (Math.sin(t * 1.1) + 1) / 2
        : 0.08;
    const point = curve.getPoint(progress);
    trail.current.position.set(point.x, point.y, point.z);
  });

  return (
    <>
      <mesh geometry={geometry}>
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={topic.live.status === 'idle' ? 0.12 : 0.55} transparent opacity={topic.live.status === 'missing' ? 0.14 : 0.32} />
      </mesh>
      {topic.live.status !== 'missing' && (
        <mesh ref={trail}>
          <sphereGeometry args={[0.09, 16, 16]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.8} transparent opacity={0.95} />
        </mesh>
      )}
    </>
  );
}

function LegendMonolith({ position, label, color, intensity }: { position: [number, number, number]; label: string; color: string; intensity: number }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.58, 0]}>
        <boxGeometry args={[0.42, 1.1, 0.42]} />
        <meshStandardMaterial color="#171311" emissive={color} emissiveIntensity={intensity} />
      </mesh>
      <mesh position={[0, 1.2, 0]}>
        <boxGeometry args={[0.28, 0.14, 0.28]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={intensity * 1.6} />
      </mesh>
      <mesh position={[0.22, 0.88, 0]}>
        <boxGeometry args={[0.12, 0.44, 0.12]} />
        <meshStandardMaterial color="#2a2117" />
      </mesh>
    </group>
  );
}

function OfficeRoom({ topics, reducedMotion }: { topics: TeamTopic[]; reducedMotion: boolean }) {
  const hubPosition: [number, number, number] = [0, 0.14, 0];
  const activeCount = topics.filter((topic) => topic.live.status === 'running' || topic.live.status === 'recent').length;
  const deskLayout = useMemo<DeskLayout[]>(() => {
    const rows = Math.ceil(topics.length / 2);
    const laneSpacing = rows > 1 ? 2.55 : 0;
    return topics.map((topic, index) => {
      const side: 'left' | 'right' = index % 2 === 0 ? 'left' : 'right';
      const row = Math.floor(index / 2);
      const z = (row - Math.max(rows - 1, 0) / 2) * laneSpacing;
      const x = side === 'left' ? -4.15 : 4.15;
      return {
        topic,
        side,
        position: [x, 0, z] as [number, number, number],
        rotationY: side === 'left' ? -Math.PI / 2 : Math.PI / 2,
        laneStart: [side === 'left' ? -2.3 : 2.3, 0.06, z] as [number, number, number],
      };
    });
  }, [topics]);

  return (
    <>
      <color attach="background" args={['#0f0b08']} />
      <fog attach="fog" args={['#0f0b08', 10, 24]} />
      <ambientLight intensity={0.8} color="#f5e8bd" />
      <pointLight position={[0, 6.5, 0]} intensity={22} color="#f8d375" />
      <pointLight position={[-5.5, 3.2, 4.4]} intensity={10} color="#67e8f9" />
      <pointLight position={[5.5, 2.8, -4.2]} intensity={8} color="#a855f7" />
      <spotLight position={[0, 7, 8]} angle={0.45} penumbra={0.75} intensity={18} color="#ecd58d" />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[18, 18]} />
        <meshStandardMaterial color="#140f0a" metalness={0.18} roughness={0.94} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <ringGeometry args={[1.8, 7.6, 64]} />
        <meshBasicMaterial color="#d4ba68" transparent opacity={0.12} />
      </mesh>

      <mesh position={[0, 1.8, -7.2]}>
        <boxGeometry args={[15.2, 3.6, 0.18]} />
        <meshStandardMaterial color="#18120d" emissive="#23190f" emissiveIntensity={0.55} />
      </mesh>
      <mesh position={[-7.5, 1.7, 0]}>
        <boxGeometry args={[0.18, 3.4, 14.8]} />
        <meshStandardMaterial color="#18120d" emissive="#1f1710" emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[7.5, 1.7, 0]}>
        <boxGeometry args={[0.18, 3.4, 14.8]} />
        <meshStandardMaterial color="#18120d" emissive="#1f1710" emissiveIntensity={0.4} />
      </mesh>

      <mesh position={[0, 3.25, -1.4]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[5.9, 0.08, 18, 72]} />
        <meshStandardMaterial color="#ecd58d" emissive="#ecd58d" emissiveIntensity={0.5} />
      </mesh>

      <mesh position={[-4.8, 1.8, -7.06]}>
        <boxGeometry args={[3.2, 1.5, 0.12]} />
        <meshStandardMaterial color="#19222a" emissive="#67e8f9" emissiveIntensity={0.42} />
      </mesh>
      <mesh position={[4.8, 1.8, -7.06]}>
        <boxGeometry args={[3.2, 1.5, 0.12]} />
        <meshStandardMaterial color="#2a1f16" emissive="#d4ba68" emissiveIntensity={0.42} />
      </mesh>

      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[2.2, 13.2]} />
        <meshBasicMaterial color="#67e8f9" transparent opacity={0.06} />
      </mesh>

      <Hub activeCount={activeCount} reducedMotion={reducedMotion} />

      {deskLayout.map((desk, index) => (
        <group key={desk.topic.topicId}>
          <DeskCluster
            topic={desk.topic}
            position={desk.position}
            rotationY={desk.rotationY}
            reducedMotion={reducedMotion}
            side={desk.side}
            hubPosition={hubPosition}
            seed={index + 1}
          />
          <ActivityLane start={desk.laneStart} end={hubPosition} topic={desk.topic} reducedMotion={reducedMotion} />
        </group>
      ))}

      <LegendMonolith position={[-6.2, 0, 5.5]} label="running" color="#67e8f9" intensity={0.9} />
      <LegendMonolith position={[-4.8, 0, 5.5]} label="recent" color="#fbbf24" intensity={0.65} />
      <LegendMonolith position={[4.8, 0, 5.5]} label="idle" color="#8f7a53" intensity={0.28} />
      <LegendMonolith position={[6.2, 0, 5.5]} label="missing" color="#f87171" intensity={0.5} />
    </>
  );
}

function FallbackOffice({ topics }: { topics: TeamTopic[] }) {
  return (
    <div className="relative h-[360px] overflow-hidden rounded-xl border border-[var(--watch-panel-border)] bg-[radial-gradient(circle_at_top,rgba(103,232,249,0.12),transparent_28%),linear-gradient(180deg,rgba(22,17,12,0.98),rgba(14,11,8,0.98))] sm:h-[460px]">
      <div className="absolute inset-x-4 top-4 text-[10px] uppercase tracking-[0.22em] text-[var(--watch-text-muted)]">
        full office preview
      </div>
      <div className="absolute inset-x-6 top-10 h-32 rounded-full border border-[rgba(103,232,249,0.28)] bg-[rgba(103,232,249,0.08)] blur-sm" />
      <div className="absolute inset-x-0 top-28 flex justify-center">
        <div className="h-24 w-24 rounded-full border border-[rgba(212,186,104,0.45)] bg-[rgba(212,186,104,0.12)] shadow-[0_0_40px_rgba(103,232,249,0.2)]" />
      </div>
      <div className="absolute bottom-6 left-4 right-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {topics.slice(0, 8).map((topic) => (
          <div key={topic.topicId} className="rounded-lg border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.32)] px-3 py-2 backdrop-blur-sm">
            <div className="truncate text-[10px] uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">{topic.configured.label}</div>
            <div className="mt-1 text-[11px] text-[var(--watch-text-bright)]">{actionLabel(topic)}</div>
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
    <div className="h-[380px] overflow-hidden rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.32)] sm:h-[560px]">
      <Canvas
        camera={{ position: [0, 8.2, 12], fov: 40 }}
        dpr={typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, window.innerWidth < 768 ? 1.15 : 1.5)}
      >
        <OfficeRoom topics={topics} reducedMotion={reducedMotion} />
      </Canvas>
    </div>
  );
}
