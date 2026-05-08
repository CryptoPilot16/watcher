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
  applicationName: 'AXIOM',
  manifest: '/axiom.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'AXIOM',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
  icons: {
    icon: [
      { url: '/watch-favicon-v4.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    shortcut: '/watch-favicon-v4.svg',
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
};

export default function AxiomLayout({ children }: { children: React.ReactNode }) {
  return <div className="axiom-app">{children}</div>;
}
