'use client';

import { Suspense, useMemo, type ReactNode } from 'react';
import type { GroupProps } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';

export const OFFICE_ASSET_ROOT = '/assets/office';

export type OfficeAssetSlotId =
  | 'desk'
  | 'deskChair'
  | 'breakSofa'
  | 'breakTable'
  | 'plant'
  | 'hubCore'
  | 'wallFrame'
  | 'ceilingLamp'
  | 'coffeeMachine';

type PrimitiveAssetEntry = {
  kind: 'primitive';
  notes?: string;
};

type GltfAssetEntry = {
  kind: 'gltf';
  url: string;
  scale?: number | [number, number, number];
  position?: [number, number, number];
  rotation?: [number, number, number];
  notes?: string;
};

export type OfficeAssetEntry = PrimitiveAssetEntry | GltfAssetEntry;
export type OfficeAssetManifest = Record<OfficeAssetSlotId, OfficeAssetEntry>;

export const OFFICE_ASSET_MANIFEST: OfficeAssetManifest = {
  desk: { kind: 'primitive', notes: 'Swap with a workstation desk mesh.' },
  deskChair: { kind: 'primitive', notes: 'Swap with an office chair mesh.' },
  breakSofa: { kind: 'primitive', notes: 'Swap with lounge seating mesh.' },
  breakTable: { kind: 'primitive', notes: 'Swap with side-table mesh.' },
  plant: { kind: 'primitive', notes: 'Swap with a potted plant mesh.' },
  hubCore: { kind: 'primitive', notes: 'Swap with central hub/console mesh.' },
  wallFrame: { kind: 'primitive', notes: 'Swap with wall decoration mesh.' },
  ceilingLamp: { kind: 'primitive', notes: 'Swap with hanging light mesh.' },
  coffeeMachine: { kind: 'primitive', notes: 'Swap with kitchen appliance mesh.' },
};

export function withOfficeAssetPath(fileName: string) {
  return `${OFFICE_ASSET_ROOT}/gltf/${fileName}`;
}

export function preloadOfficeAssets(manifest?: Partial<OfficeAssetManifest>) {
  const resolved = { ...OFFICE_ASSET_MANIFEST, ...(manifest ?? {}) };
  for (const entry of Object.values(resolved)) {
    if (entry.kind === 'gltf' && entry.url) useGLTF.preload(entry.url);
  }
}

function GltfAsset({ entry }: { entry: GltfAssetEntry }) {
  const gltf = useGLTF(entry.url);
  const scene = useMemo(() => gltf.scene.clone(true), [gltf.scene]);

  return (
    <primitive
      object={scene}
      position={entry.position ?? [0, 0, 0]}
      rotation={entry.rotation ?? [0, 0, 0]}
      scale={entry.scale ?? 1}
    />
  );
}

export function OfficeAssetSlot({
  slot,
  fallback,
  manifest,
  ...groupProps
}: GroupProps & {
  slot: OfficeAssetSlotId;
  fallback: ReactNode;
  manifest?: Partial<OfficeAssetManifest>;
}) {
  const resolved = useMemo(() => ({ ...OFFICE_ASSET_MANIFEST, ...(manifest ?? {}) }), [manifest]);
  const entry = resolved[slot];

  if (!entry || entry.kind === 'primitive') {
    return <group {...groupProps}>{fallback}</group>;
  }

  return (
    <group {...groupProps}>
      <Suspense fallback={fallback}>
        <GltfAsset entry={entry} />
      </Suspense>
    </group>
  );
}
