import type { Metadata, Viewport } from 'next';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f0d09',
};

export const metadata: Metadata = {
  title: 'Watcher',
  description: 'Private monitoring dashboard',
  appleWebApp: {
    capable: true,
    title: 'Watch',
    statusBarStyle: 'black-translucent',
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
  manifest: '/site.webmanifest',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
