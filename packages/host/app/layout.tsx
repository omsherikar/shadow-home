import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import './stage.css';
import './chat.css';

export const metadata: Metadata = {
  title: 'Shadow Home on a simulated Echo Show',
  description: 'Every smart-home plan is checked on a digital twin before it runs.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
