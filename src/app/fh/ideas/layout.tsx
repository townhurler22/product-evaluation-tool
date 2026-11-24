import type { ReactNode } from 'react';
import IdeasWorkspace from '../_components/ideas-workspace';

// The workspace lives in the layout so switching view tabs keeps filters, selection rules and caches (FH-108).
export default function IdeasLayout({ children }: { children: ReactNode }) {
  return <><IdeasWorkspace />{children}</>;
}
