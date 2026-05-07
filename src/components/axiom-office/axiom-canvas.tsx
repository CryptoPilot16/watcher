'use client';

import { useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Billboard, OrbitControls, RoundedBox } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';

export type AxiomAgent = {
  id: string;
  role: 'ceo' | 'manager' | 'coder';
  name: string;
  team: number; // 0-9 for managers/coders, -1 for CEO
  status: 'idle' | 'working' | 'busy';
};

const TEAM_COUNT = 10;
const ROWS_PER_TEAM = 5; // 1 manager + 4 coders
const TEAM_SPACING_X = 4.0; // distance between teams along X
const ROW_SPACING_Z = 2.2; // distance between rows within a team

const CEO_POS: [number, number, number] = [0, 0, 9];
const TEAM_X_OFFSET = -((TEAM_COUNT - 1) * TEAM_SPACING_X) / 2;

function teamPositionX(teamIndex: number): number {
  return TEAM_X_OFFSET + teamIndex * TEAM_SPACING_X;
}

function deskPositionForAgent(agent: AxiomAgent): [number, number, number] {
  if (agent.role === 'ceo') return CEO_POS;
  const x = teamPositionX(agent.team);
  // manager sits at the front row of the team (z closest to CEO);
  // coders fill rows 2..5 (further back)
  const teamMembers = ROWS_PER_TEAM;
  // row 0 = manager (z = +2), rows 1..4 = coders (z = 0, -2, -4, -6)
  const isManager = agent.role === 'manager';
  // Determine row index inside the team
  const memberIndex = isManager ? 0 : (parseInt(agent.id.split('-c')[1] ?? '0', 10) % 4) + 1;
  const z = 5 - memberIndex * ROW_SPACING_Z; // 5, 2.8, 0.6, -1.6, -3.8
  return [x, 0, z];
}

function statusColor(status: AxiomAgent['status']): string {
  if (status === 'working') return '#4ade80';
  if (status === 'busy') return '#fbbf24';
  return '#94a3b8';
}

function Desk({ agent, onSelect, selected }: { agent: AxiomAgent; onSelect: (id: string) => void; selected: boolean }) {
  const pos = deskPositionForAgent(agent);
  const isCEO = agent.role === 'ceo';
  const isManager = agent.role === 'manager';
  const deskColor = isCEO ? '#a3764f' : isManager ? '#5b6478' : '#717a8a';
  const deskHeight = isCEO ? 0.6 : 0.5;
  const deskWidth = isCEO ? 2.2 : 1.4;
  const deskDepth = isCEO ? 1.4 : 1.0;
  const accent = statusColor(agent.status);

  return (
    <group position={pos} onClick={(e) => { e.stopPropagation(); onSelect(agent.id); }}>
      {/* Desk top */}
      <RoundedBox args={[deskWidth, 0.08, deskDepth]} radius={0.03} smoothness={3} position={[0, deskHeight, 0]} castShadow>
        <meshStandardMaterial color={deskColor} roughness={0.85} />
      </RoundedBox>
      {/* Desk legs */}
      {([
        [-deskWidth / 2 + 0.08, deskHeight / 2, -deskDepth / 2 + 0.08],
        [+deskWidth / 2 - 0.08, deskHeight / 2, -deskDepth / 2 + 0.08],
        [-deskWidth / 2 + 0.08, deskHeight / 2, +deskDepth / 2 - 0.08],
        [+deskWidth / 2 - 0.08, deskHeight / 2, +deskDepth / 2 - 0.08],
      ] as [number, number, number][]).map((p, i) => (
        <mesh key={i} position={p} castShadow>
          <boxGeometry args={[0.06, deskHeight, 0.06]} />
          <meshStandardMaterial color="#3a3f4a" />
        </mesh>
      ))}
      {/* Monitor */}
      <mesh position={[0, deskHeight + 0.32, -0.18]} castShadow>
        <boxGeometry args={[isCEO ? 1.1 : 0.7, 0.42, 0.04]} />
        <meshStandardMaterial color="#0f1218" emissive={accent} emissiveIntensity={agent.status === 'working' ? 0.4 : 0.06} />
      </mesh>
      {/* Monitor stand */}
      <mesh position={[0, deskHeight + 0.1, -0.16]} castShadow>
        <boxGeometry args={[0.08, 0.18, 0.06]} />
        <meshStandardMaterial color="#2a2f3a" />
      </mesh>
      {/* Chair */}
      <group position={[0, 0, deskDepth / 2 + 0.5]}>
        <mesh position={[0, 0.4, 0]} castShadow>
          <boxGeometry args={[0.5, 0.08, 0.5]} />
          <meshStandardMaterial color={isCEO ? '#5a3d25' : '#3a4252'} />
        </mesh>
        <mesh position={[0, 0.7, -0.22]} castShadow>
          <boxGeometry args={[0.5, 0.6, 0.06]} />
          <meshStandardMaterial color={isCEO ? '#5a3d25' : '#3a4252'} />
        </mesh>
        <mesh position={[0, 0.18, 0]} castShadow>
          <cylinderGeometry args={[0.04, 0.04, 0.36, 8]} />
          <meshStandardMaterial color="#2a2f3a" />
        </mesh>
      </group>
      {/* Status halo on desk top */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, deskHeight + 0.045, 0]}>
        <ringGeometry args={[deskWidth * 0.32, deskWidth * 0.4, 24]} />
        <meshBasicMaterial color={accent} transparent opacity={agent.status === 'working' ? 0.6 : 0.2} />
      </mesh>
      {/* Selection highlight */}
      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
          <ringGeometry args={[1.0, 1.15, 32]} />
          <meshBasicMaterial color="#ffcf4d" transparent opacity={0.7} />
        </mesh>
      )}
      {/* Hover/select label */}
      <Billboard position={[0, deskHeight + 0.95, 0]}>
        <mesh>
          <planeGeometry args={[1.4, 0.32]} />
          <meshBasicMaterial color="#0f0d09" transparent opacity={0.85} />
        </mesh>
      </Billboard>
    </group>
  );
}

function AxiomFloor() {
  return (
    <>
      {/* Main floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
        <planeGeometry args={[48, 28]} />
        <meshStandardMaterial color="#181b22" roughness={0.92} />
      </mesh>
      {/* Central carpet for the team area */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[44, 16]} />
        <meshStandardMaterial color="#22262e" roughness={0.95} />
      </mesh>
      {/* CEO accent platform */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 9]} receiveShadow>
        <planeGeometry args={[5, 3]} />
        <meshStandardMaterial color="#2c2620" roughness={0.92} />
      </mesh>
    </>
  );
}

function AxiomWalls() {
  const wallColor = '#262b34';
  return (
    <>
      <mesh position={[0, 2.5, -8]}><boxGeometry args={[48, 5, 0.2]} /><meshStandardMaterial color={wallColor} roughness={0.9} /></mesh>
      <mesh position={[-23.9, 2.5, 0]}><boxGeometry args={[0.2, 5, 28]} /><meshStandardMaterial color={wallColor} roughness={0.9} /></mesh>
      <mesh position={[23.9, 2.5, 0]}><boxGeometry args={[0.2, 5, 28]} /><meshStandardMaterial color={wallColor} roughness={0.9} /></mesh>
    </>
  );
}

function CameraDirector({ controlsRef, mode, focusTarget }: { controlsRef: RefObject<OrbitControlsImpl>; mode: 'overview' | 'focus' | 'free'; focusTarget: [number, number, number] | null }) {
  const { camera } = useThree();
  const animating = useRef(false);
  const animProgress = useRef(0);
  const lastMode = useRef(mode);
  const lastFocusId = useRef('');
  const targetVec = useRef(new THREE.Vector3());
  const offsetVec = useRef(new THREE.Vector3());
  const destination = useRef(new THREE.Vector3());

  useFrame((_, delta) => {
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

    const overviewTarget: [number, number, number] = [0, 1.5, 1];
    const desiredTarget = mode === 'focus' && focusTarget ? focusTarget : overviewTarget;
    const focusOffset: [number, number, number] = [4.5, 3.0, 5.5];
    const overviewOffset: [number, number, number] = [0, 12, 16];

    targetVec.current.set(...desiredTarget);
    offsetVec.current.set(...(mode === 'focus' && focusTarget ? focusOffset : overviewOffset));
    destination.current.copy(targetVec.current).add(offsetVec.current);
    const damping = Math.min(1, delta * 3.3);
    camera.position.lerp(destination.current, damping);

    if (controlsRef.current) {
      controlsRef.current.target.lerp(targetVec.current, damping);
      controlsRef.current.update();
    } else {
      camera.lookAt(targetVec.current);
    }
    animProgress.current += delta;
    if (animProgress.current > 1.5) animating.current = false;
  });

  return null;
}

function AgentInfoCard({ agent, onClose }: { agent: AxiomAgent; onClose: () => void }) {
  const color = statusColor(agent.status);
  return (
    <div className="pointer-events-auto absolute right-3 top-3 z-10 w-[260px] rounded-lg border border-[var(--watch-panel-border-strong)] bg-[var(--watch-panel-strong)] p-3 text-[var(--watch-text)] shadow-2xl">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-muted)]">{agent.role}</div>
          <div className="truncate text-base font-semibold" style={{ color }}>{agent.name}</div>
        </div>
        <button type="button" onClick={onClose} className="rounded border border-[var(--watch-panel-border)] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--watch-text-muted)] hover:text-[var(--watch-text)]">close</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--watch-text-muted)]">
        <div>
          <div>team</div>
          <div className="mt-1 text-[11px] text-[var(--watch-text-bright)]">{agent.team < 0 ? '—' : `T${String(agent.team + 1).padStart(2, '0')}`}</div>
        </div>
        <div>
          <div>status</div>
          <div className="mt-1 text-[11px]" style={{ color }}>{agent.status}</div>
        </div>
      </div>
      <div className="mt-3 text-[10px] uppercase tracking-[0.14em] text-[var(--watch-text-muted)]">runtime</div>
      <div className="mt-1 text-[11px] text-[var(--watch-text-bright)]">claude code</div>
    </div>
  );
}

export function AxiomOfficeCanvas({ agents }: { agents: AxiomAgent[] }) {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cameraMode, setCameraMode] = useState<'overview' | 'focus' | 'free'>('overview');

  const selected = useMemo(() => agents.find((a) => a.id === selectedId) ?? null, [agents, selectedId]);
  const focusTarget = useMemo<[number, number, number] | null>(() => {
    if (!selected) return null;
    const p = deskPositionForAgent(selected);
    return [p[0], 0.92, p[2]];
  }, [selected]);

  const ceo = agents.find((a) => a.role === 'ceo');
  const managers = agents.filter((a) => a.role === 'manager').sort((a, b) => a.team - b.team);
  const coders = agents.filter((a) => a.role === 'coder');
  const stats = {
    total: agents.length,
    working: agents.filter((a) => a.status === 'working').length,
    busy: agents.filter((a) => a.status === 'busy').length,
  };

  const buttonCls = (active: boolean) => `watch-pill text-[11px] uppercase ${active ? 'watch-pill--active' : ''}`;

  return (
    <div className="relative h-[86dvh] min-h-[560px] w-full overflow-hidden rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.12)] sm:h-[720px] lg:h-[800px]">
      <Canvas
        camera={{ position: [0, 12, 16], fov: 38, near: 0.1, far: 220 }}
        dpr={typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 1.7)}
        onCreated={({ camera }) => camera.lookAt(0, 1.5, 1)}
        onPointerMissed={() => { setSelectedId(null); setCameraMode('overview'); }}
      >
        <color attach="background" args={['#0f1116']} />
        <ambientLight intensity={1.0} color="#ffffff" />
        <hemisphereLight args={['#ffffff', '#1a1c22', 1.0]} />
        <directionalLight position={[10, 14, 8]} intensity={1.2} color="#fff8ef" />
        <pointLight position={[0, 6, 9]} intensity={2.4} color="#ffd99a" />

        <AxiomFloor />
        <AxiomWalls />

        {agents.map((agent) => (
          <Desk
            key={agent.id}
            agent={agent}
            onSelect={(id) => { setSelectedId(id); setCameraMode('focus'); }}
            selected={selectedId === agent.id}
          />
        ))}

        <CameraDirector controlsRef={controlsRef} mode={cameraMode} focusTarget={focusTarget} />

        <OrbitControls
          ref={controlsRef}
          enablePan
          enableZoom
          enableRotate
          enableDamping
          dampingFactor={0.08}
          minDistance={4}
          maxDistance={60}
          minPolarAngle={0.2}
          maxPolarAngle={Math.PI - 0.05}
          target={[0, 1.5, 1]}
          screenSpacePanning
          onStart={() => setCameraMode('free')}
        />

        <EffectComposer>
          <Bloom intensity={0.25} luminanceThreshold={0.7} luminanceSmoothing={0.9} />
          <Vignette offset={0.12} darkness={0.22} />
        </EffectComposer>
      </Canvas>

      {/* Header / stats overlay */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col gap-1.5">
        <div className="rounded-md border border-[var(--watch-panel-border)] bg-[var(--watch-panel-strong)] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-bright)] shadow-lg">
          axiom · {stats.total} agents · {ceo ? '1 ceo' : ''} · {managers.length} managers · {coders.length} coders
        </div>
        <div className="rounded-md border border-[var(--watch-panel-border)] bg-[var(--watch-panel-strong)] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-muted)] shadow-lg">
          🟢 {stats.working} working · 🟡 {stats.busy} busy
        </div>
      </div>

      {/* Mode buttons */}
      <div className="pointer-events-auto absolute right-3 bottom-3 z-10 flex items-center gap-1.5">
        <button type="button" className={buttonCls(cameraMode === 'overview')} onClick={() => { setCameraMode('overview'); setSelectedId(null); }}>overview</button>
        <button type="button" className={buttonCls(cameraMode === 'focus')} onClick={() => setCameraMode('focus')}>focus</button>
        <button type="button" className={buttonCls(cameraMode === 'free')} onClick={() => setCameraMode('free')}>free</button>
      </div>

      {selected && <AgentInfoCard agent={selected} onClose={() => { setSelectedId(null); setCameraMode('overview'); }} />}
    </div>
  );
}

export function buildAxiomAgents(): AxiomAgent[] {
  const agents: AxiomAgent[] = [];
  agents.push({ id: 'ceo', role: 'ceo', name: 'AXIOM-1', team: -1, status: 'working' });
  for (let t = 0; t < TEAM_COUNT; t++) {
    agents.push({
      id: `t${t}-m`,
      role: 'manager',
      name: `MGR-${String(t + 1).padStart(2, '0')}`,
      team: t,
      status: ['working', 'busy', 'idle'][t % 3] as AxiomAgent['status'],
    });
    for (let c = 0; c < 4; c++) {
      agents.push({
        id: `t${t}-c${c}`,
        role: 'coder',
        name: `DEV-${String(t + 1).padStart(2, '0')}${String.fromCharCode(65 + c)}`,
        team: t,
        status: ['working', 'idle', 'busy', 'working'][c] as AxiomAgent['status'],
      });
    }
  }
  return agents;
}
