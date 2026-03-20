import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ViralClip AI — Auto YouTube Clipper',
  description: 'Generate viral clips otomatis dari video YouTube dengan AI.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
