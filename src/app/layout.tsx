import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = { title: 'SmartSign', robots: { index: false } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="id"><body style={{ fontFamily: 'system-ui, sans-serif', margin: 0 }}>{children}</body></html>);
}
