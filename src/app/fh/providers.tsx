'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export default function Providers({ children }: { children: ReactNode }) {
  // D-09: detail and lookups are cached by key and updated or invalidated by events, never refetched blindly.
  const [qc] = useState(() => new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 } },
  }));
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
