import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'CLAWNUX Watch',
};

export default function WatchLayout({ children }: { children: React.ReactNode }) {
  return children;
}
