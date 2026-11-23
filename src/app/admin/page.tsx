import type { Metadata } from 'next';
import AdminConsole from './admin-console';

export const metadata: Metadata = { title: 'Admin | Product Evaluation Tool' };

export default function AdminPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-bold">Workspace admin</h1>
      <AdminConsole />
    </main>
  );
}
