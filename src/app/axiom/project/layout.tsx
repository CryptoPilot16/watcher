import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Project · AXIOM',
  description: 'Live file tree and change feed for the project the AXIOM agents are building.',
};

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
