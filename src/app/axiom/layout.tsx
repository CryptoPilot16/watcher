import type { Metadata, Viewport } from 'next';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: '#0f0d09',
};

export const metadata: Metadata = {
  title: {
    default: 'AXIOM Office',
    template: '%s · AXIOM',
  },
  description: 'AXIOM operations floor — 41 AI agents across 10 teams of 4.',
  applicationName: 'Watcher',
  manifest: '/axiom.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Watcher',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
  icons: {
    icon: [
      { url: '/favicon-32x32.png?v=20260518f', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png?v=20260518f', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png?v=20260518f', sizes: '512x512', type: 'image/png' },
    ],
    shortcut: '/favicon.ico?v=20260518f',
    apple: [{ url: '/apple-touch-icon.png?v=20260518f', sizes: '180x180', type: 'image/png' }],
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
};

export default function AxiomLayout({ children }: { children: React.ReactNode }) {
  return <div className="axiom-app">{children}</div>;
}
