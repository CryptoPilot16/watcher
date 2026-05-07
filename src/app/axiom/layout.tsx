import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AXIOM Office',
  description: 'AXIOM operations floor — 51 AI agents in a 10×5 team grid.',
};

export default function AxiomLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
