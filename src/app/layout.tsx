import type { Metadata, Viewport } from 'next';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://watch.clawnux.com';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: '#0f0d09',
};

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Watcher',
  description: 'Self-hosted mission control for OpenClaw agent teams with live session feeds, office-floor visibility, lane control, and service health.',
  appleWebApp: {
    capable: true,
    title: 'Watch',
    statusBarStyle: 'black-translucent',
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
  manifest: '/site.webmanifest',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
