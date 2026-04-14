'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { TeamTopic } from '@/lib/watch-team';

function statusColor(status: TeamTopic['live']['status']) {
  switch (status) {
    case 'running':
      return '#67e8f9';
    case 'recent':
      return '#fbbf24';
    case 'idle':
      return '#7c6f57';
    case 'missing':
      return '#f87171';
    default:
      return '#d4ba68';
  }
}

function statusIntensity(status: TeamTopic['live']['status']) {
  switch (status) {
    case 'running':
      return 1.5;
    case 'recent':
      return 1.0;
    case 'idle':
      return 0.35;
    case 'missing':
      return 0.75;
    default:
      return 0.35;
  }
}

function DeskPod({ topic, position, rotationY, reducedMotion }: {
  topic: TeamTopic;
  position: [number, number, number];
  rotationY: number;
  reducedMotion: boolean;
}) {
  const beacon = useRef<THREE.Mesh>(null);
  const monitor = useRef<THREE.Mesh>(null);
  const color = useMemo(() => new THREE.Color(statusColor(topic.live.status)), [topic.live.status]);
  const intensity = statusIntensity(topic.live.status);

  useFrame(({ clock }) => {
    if (reducedMotion) return;
    const t = clock.getElapsedTime();
    const pulse = 0.88 + Math.sin(t * (topic.live.status === 'running' ? 3.2 : 1.5) + position[0]) * 0.12;
    if (beacon.current) {
      beacon.current.scale.setScalar(pulse);
      beacon.current.position.y = 1.06 + pulse * 0.05;
    }
    if (monitor.current) {
      monitor.current.rotation.z = Math.sin(t * 1.1 + position[2]) * 0.02;
    }
  });

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh position={[0, 0.16, 0]} castShadow={false} receiveShadow={false}>
        <boxGeometry args={[1.55, 0.18, 1.05]} />
        <meshStandardMaterial color="#251d14" metalness={0.3} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.78, -0.2]} ref={monitor}>
        <boxGeometry args={[0.72, 0.48, 0.08]} />
        <meshStandardMaterial color="#111827" emissive={color} emissiveIntensity={intensity} />
      </mesh>
      <mesh position={[0, 0.48, 0.15]}>
        <boxGeometry args={[0.6, 0.06, 0.38]} />
        <meshStandardMaterial color="#111111" />
      </mesh>
      <mesh position={[0.56, 0.34, 0.28]} ref={beacon}>
        <sphereGeometry args={[0.1, 20, 20]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={intensity * 2.5} />
      </mesh>
      <mesh position={[0, 0.74, -0.24]}>
        <boxGeometry args={[0.58, 0.34, 0.02]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={intensity * 1.5} transparent opacity={0.7} />
      </mesh>
    </group>
  );
}

function CommandTable({ activeCount, reducedMotion }: { activeCount: number; reducedMotion: boolean }) {
  const ring = useRef<THREE.Mesh>(null);
  const pillar = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (reducedMotion) return;
    const t = clock.getElapsedTime();
    if (ring.current) {
      ring.current.rotation.y = t * 0.45;
      const s = 1 + Math.sin(t * 2) * 0.05;
      ring.current.scale.set(s, 1, s);
    }
    if (pillar.current) {
      pillar.current.scale.y = 0.95 + Math.sin(t * 2.4) * 0.06 + Math.min(activeCount, 6) * 0.02;
    }
  });

  return (
    <group position={[0, 0, 0]}>
      <mesh position={[0, 0.34, 0]}>
        <cylinderGeometry args={[1.25, 1.45, 0.3, 7]} />
        <meshStandardMaterial color="#241c13" metalness={0.45} roughness={0.42} />
      </mesh>
      <mesh position={[0, 0.54, 0]}>
        <cylinderGeometry args={[0.48, 0.48, 0.7, 24]} />
        <meshStandardMaterial color="#0f172a" emissive="#67e8f9" emissiveIntensity={0.9} transparent opacity={0.82} />
      </mesh>
      <mesh ref={pillar} position={[0, 1.06, 0]}>
        <cylinderGeometry args={[0.13, 0.13, 1.06, 18]} />
        <meshStandardMaterial color="#67e8f9" emissive="#67e8f9" emissiveIntensity={1.8} transparent opacity={0.85} />
      </mesh>
      <mesh ref={ring} position={[0, 1.54, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.72, 0.04, 14, 48]} />
        <meshStandardMaterial color="#d4ba68" emissive="#d4ba68" emissiveIntensity={1.4} />
      </mesh>
    </group>
  );
}

function Beam({ start, end, color }: { start: [number, number, number]; end: [number, number, number]; color: string }) {
  const geometry = useMemo(() => {
    const points = [new THREE.Vector3(...start), new THREE.Vector3(...end)];
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [start, end]);

  return (
    <line geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={0.65} />
    </line>
  );
}

function OpsLoft({ topics, reducedMotion }: { topics: TeamTopic[]; reducedMotion: boolean }) {
  const activeCount = topics.filter((topic) => topic.live.status === 'running' || topic.live.status === 'recent').length;
  const deskLayout = useMemo(() => {
    const radius = 4.7;
    return topics.map((topic, index) => {
      const angle = -Math.PI * 0.9 + (index / Math.max(topics.length - 1, 1)) * Math.PI * 1.8;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius * 0.7 + 0.35;
      return {
        topic,
        position: [x, 0, z] as [number, number, number],
        rotationY: -angle + Math.PI / 2,
      };
    });
  }, [topics]);

  return (
    <>
      <color attach="background" args={['#120e09']} />
      <fog attach="fog" args={['#120e09', 9, 20]} />
      <ambientLight intensity={0.9} color="#f3e6bc" />
      <pointLight position={[0, 7, 2]} intensity={18} color="#f8d375" />
      <pointLight position={[0, 4, 7]} intensity={12} color="#67e8f9" />
      <pointLight position={[-6, 2, -4]} intensity={8} color="#a855f7" />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow={false}>
        <planeGeometry args={[18, 12]} />
        <meshStandardMaterial color="#15100b" metalness={0.2} roughness={0.92} />
      </mesh>

      <mesh position={[0, 1.4, -5.1]}>
        <boxGeometry args={[13.5, 2.8, 0.16]} />
        <meshStandardMaterial color="#17120c" emissive="#22190f" emissiveIntensity={0.6} />
      </mesh>
      <mesh position={[-6.6, 1.2, 0]}>
        <boxGeometry args={[0.16, 2.4, 10.2]} />
        <meshStandardMaterial color="#17120c" emissive="#1a140d" emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[6.6, 1.2, 0]}>
        <boxGeometry args={[0.16, 2.4, 10.2]} />
        <meshStandardMaterial color="#17120c" emissive="#1a140d" emissiveIntensity={0.4} />
      </mesh>

      <CommandTable activeCount={activeCount} reducedMotion={reducedMotion} />

      {deskLayout.map(({ topic, position, rotationY }) => (
        <group key={topic.topicId}>
          <DeskPod topic={topic} position={position} rotationY={rotationY} reducedMotion={reducedMotion} />
          {(topic.live.status === 'running' || topic.live.status === 'recent') && (
            <Beam start={[0, 1.15, 0]} end={[position[0], 0.9, position[2]]} color={statusColor(topic.live.status)} />
          )}
        </group>
      ))}

      {[-4.2, -3.2, -2.2, -1.2, 1.2, 2.2, 3.2, 4.2].map((x, index) => (
        <group key={x} position={[x, 0, -4.3]}>
          <mesh position={[0, 0.5, 0]}>
            <boxGeometry args={[0.48, 1, 0.48]} />
            <meshStandardMaterial color="#141414" emissive={index < activeCount ? '#67e8f9' : '#d4ba68'} emissiveIntensity={index < activeCount ? 1.3 : 0.25} />
          </mesh>
          <mesh position={[0, 1.12, 0]}>
            <boxGeometry args={[0.36, 0.14, 0.36]} />
            <meshStandardMaterial color={index < activeCount ? '#67e8f9' : '#d4ba68'} emissive={index < activeCount ? '#67e8f9' : '#d4ba68'} emissiveIntensity={index < activeCount ? 1.8 : 0.35} />
          </mesh>
        </group>
      ))}

      <mesh position={[5.2, 0.72, -2.6]}>
        <cylinderGeometry args={[0.44, 0.44, 1.42, 24]} />
        <meshStandardMaterial color="#141018" emissive="#a855f7" emissiveIntensity={0.85} />
      </mesh>
      <mesh position={[5.2, 1.46, -2.6]}>
        <torusGeometry args={[0.72, 0.03, 14, 40]} />
        <meshStandardMaterial color="#67e8f9" emissive="#67e8f9" emissiveIntensity={1.5} />
      </mesh>
    </>
  );
}

function FallbackOffice({ topics }: { topics: TeamTopic[] }) {
  return (
    <div className="relative h-[340px] overflow-hidden rounded-xl border border-[var(--watch-panel-border)] bg-[radial-gradient(circle_at_top,rgba(103,232,249,0.12),transparent_28%),linear-gradient(180deg,rgba(22,17,12,0.98),rgba(14,11,8,0.98))]">
      <div className="absolute inset-x-6 top-8 h-24 rounded-full border border-[rgba(103,232,249,0.35)] bg-[rgba(103,232,249,0.08)] blur-sm" />
      <div className="absolute inset-x-0 top-28 flex justify-center">
        <div className="h-20 w-20 rounded-full border border-[rgba(212,186,104,0.4)] bg-[rgba(212,186,104,0.12)] shadow-[0_0_40px_rgba(103,232,249,0.18)]" />
      </div>
      <div className="absolute inset-x-4 bottom-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {topics.slice(0, 8).map((topic) => (
          <div key={topic.topicId} className="rounded-lg border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.26)] px-3 py-2">
            <div className="truncate text-[10px] uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">{topic.configured.label}</div>
            <div className="mt-1 text-[11px] text-[var(--watch-text-bright)]">{topic.live.status}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TeamOfficeCanvas({ topics }: { topics: TeamTopic[] }) {
  const [fallback, setFallback] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setReducedMotion(reduced);
    setFallback(reduced || window.innerWidth < 420);
  }, []);

  if (fallback) return <FallbackOffice topics={topics} />;

  return (
    <div className="h-[360px] overflow-hidden rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.28)] sm:h-[460px]">
      <Canvas
        camera={{ position: [0, 6.5, 9.5], fov: 42 }}
        dpr={typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, window.innerWidth < 768 ? 1 : 1.5)}
      >
        <OpsLoft topics={topics} reducedMotion={reducedMotion} />
      </Canvas>
    </div>
  );
}
