import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Product Evaluation Tool',
  description: 'Collect client feedback, triage it into a roadmap and see demand on your user-journey maps.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB">
      <body className="antialiased">{children}</body>
    </html>
  );
}
