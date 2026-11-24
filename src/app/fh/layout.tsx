import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import AppShell from '../app-shell';
import Providers from './providers';

export const metadata: Metadata = { title: 'Feedback Hub | Product Evaluation Tool' };

export default function FeedbackHubLayout({ children }: { children: ReactNode }) {
  return <Providers><AppShell>{children}</AppShell></Providers>;
}
