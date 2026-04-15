'use client';

import { Suspense, useMemo } from 'react';
import { useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

export type AvatarAccessoryId = 'sunglasses1' | 'pearlNecklace';

type AvatarAccessoryEntry = {
  objUrl: string;
  textureUrl: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: number | [number, number, number];
  alphaTest?: number;
  roughness?: number;
  metalness?: number;
};

const PRIVATE_AVATAR_ROOT = '/assets/office/private/avatar';

const AVATAR_ACCESSORIES: Record<AvatarAccessoryId, AvatarAccessoryEntry> = {
  sunglasses1: {
    objUrl: `${PRIVATE_AVATAR_ROOT}/fso-sunglasses1.obj`,
    textureUrl: `${PRIVATE_AVATAR_ROOT}/fso-sunglasses1.png`,
    position: [0, 0.755, 0.04],
    rotation: [0, Math.PI / 2, 0],
    scale: 1,
    alphaTest: 0.08,
    roughness: 0.48,
    metalness: 0.06,
  },
  pearlNecklace: {
    objUrl: `${PRIVATE_AVATAR_ROOT}/fso-pearl-necklace.obj`,
    textureUrl: `${PRIVATE_AVATAR_ROOT}/fso-pearl-necklace.png`,
    position: [0, 0.62, 0.02],
    rotation: [0, Math.PI / 2, 0],
    scale: 0.9,
    alphaTest: 0.12,
    roughness: 0.58,
    metalness: 0.02,
  },
};

function ObjAccessory({ entry }: { entry: AvatarAccessoryEntry }) {
  const model = useLoader(OBJLoader, entry.objUrl);
  const texture = useLoader(THREE.TextureLoader, entry.textureUrl);

  const scene = useMemo(() => {
    const clone = model.clone(true);
    const map = texture.clone();
    map.colorSpace = THREE.SRGBColorSpace;
    map.needsUpdate = true;

    clone.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
      child.material = new THREE.MeshStandardMaterial({
        map,
        transparent: true,
        alphaTest: entry.alphaTest ?? 0.1,
        roughness: entry.roughness ?? 0.58,
        metalness: entry.metalness ?? 0.02,
        side: THREE.DoubleSide,
      });
    });

    return clone;
  }, [entry.alphaTest, entry.metalness, entry.roughness, model, texture]);

  return <primitive object={scene} position={entry.position} rotation={entry.rotation ?? [0, 0, 0]} scale={entry.scale ?? 1} />;
}

export function AvatarAccessory({ id }: { id?: AvatarAccessoryId | null }) {
  if (!id) return null;
  const entry = AVATAR_ACCESSORIES[id];
  if (!entry) return null;

  return (
    <Suspense fallback={null}>
      <ObjAccessory entry={entry} />
    </Suspense>
  );
}
