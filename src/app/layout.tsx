import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CLAWNUX Watch',
  description: 'Private monitoring dashboard',
  icons: {
    icon: [{ url: '/watch-favicon-v4.svg', type: 'image/svg+xml' }],
    shortcut: '/watch-favicon-v4.svg',
    apple: '/apple-touch-icon.png',
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
