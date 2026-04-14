'use client';

import { Suspense, useMemo, type ReactNode } from 'react';
import type { GroupProps } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';

export const OFFICE_ASSET_ROOT = '/assets/office';
export const OFFICE_PRIVATE_ASSET_ROOT = `${OFFICE_ASSET_ROOT}/private`;
export const OFFICE_PRIVATE_ASSET_MANIFEST_URL = `${OFFICE_PRIVATE_ASSET_ROOT}/manifest.local.json`;

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
export type OfficeAssetManifestOverride = Partial<OfficeAssetManifest>;

export type OfficeLocalAssetOverride =
  | string
  | {
      file?: string;
      url?: string;
      scale?: number | [number, number, number];
      position?: [number, number, number];
      rotation?: [number, number, number];
    };

export type OfficeLocalAssetManifest = Partial<Record<OfficeAssetSlotId, OfficeLocalAssetOverride>>;

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

const OFFICE_ASSET_SLOTS: OfficeAssetSlotId[] = [
  'desk',
  'deskChair',
  'breakSofa',
  'breakTable',
  'plant',
  'hubCore',
  'wallFrame',
  'ceilingLamp',
  'coffeeMachine',
];

function isOfficeAssetSlotId(value: string): value is OfficeAssetSlotId {
  return (OFFICE_ASSET_SLOTS as string[]).includes(value);
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

export function withOfficeAssetPath(fileName: string) {
  return `${OFFICE_ASSET_ROOT}/gltf/${fileName}`;
}

export function withOfficePrivateAssetPath(fileName: string) {
  return `${OFFICE_PRIVATE_ASSET_ROOT}/${fileName.replace(/^\/+/, '')}`;
}

function toLocalOverrideEntry(value: unknown): GltfAssetEntry | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return {
      kind: 'gltf',
      url: withOfficePrivateAssetPath(value.trim()),
    };
  }

  if (!isRecord(value)) return null;

  const file = typeof value.file === 'string' ? value.file.trim() : '';
  const explicitUrl = typeof value.url === 'string' ? value.url.trim() : '';
  const url = explicitUrl || (file ? withOfficePrivateAssetPath(file) : '');
  if (!url) return null;

  const entry: GltfAssetEntry = {
    kind: 'gltf',
    url,
  };

  const scale = asScale(value.scale);
  const position = asVector3(value.position);
  const rotation = asVector3(value.rotation);

  if (scale !== undefined) entry.scale = scale;
  if (position) entry.position = position;
  if (rotation) entry.rotation = rotation;

  return entry;
}

export function parseOfficeLocalAssetManifest(value: unknown): OfficeAssetManifestOverride {
  if (!isRecord(value)) return {};

  const parsed: OfficeAssetManifestOverride = {};

  for (const [slot, raw] of Object.entries(value)) {
    if (!isOfficeAssetSlotId(slot)) continue;
    const entry = toLocalOverrideEntry(raw);
    if (entry) parsed[slot] = entry;
  }

  return parsed;
}

export async function loadOfficeLocalAssetManifest(signal?: AbortSignal): Promise<OfficeAssetManifestOverride> {
  try {
    const response = await fetch(OFFICE_PRIVATE_ASSET_MANIFEST_URL, {
      cache: 'no-store',
      signal,
    });

    if (!response.ok) return {};

    const payload = (await response.json()) as unknown;
    return parseOfficeLocalAssetManifest(payload);
  } catch {
    return {};
  }
}

export function resolveOfficeAssetManifest(...manifests: Array<OfficeAssetManifestOverride | undefined>): OfficeAssetManifest {
  const resolved: OfficeAssetManifest = { ...OFFICE_ASSET_MANIFEST };
  for (const manifest of manifests) {
    if (!manifest) continue;
    Object.assign(resolved, manifest);
  }
  return resolved;
}

export function preloadOfficeAssets(manifest?: OfficeAssetManifestOverride) {
  const resolved = resolveOfficeAssetManifest(manifest);
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
  manifest?: OfficeAssetManifestOverride;
}) {
  const resolved = useMemo(() => resolveOfficeAssetManifest(manifest), [manifest]);
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
