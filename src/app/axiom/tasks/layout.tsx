import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Tasks · AXIOM',
  description: 'Live feed of directives sent to the AXIOM operations floor and the agents’ replies.',
};

export default function TasksLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
