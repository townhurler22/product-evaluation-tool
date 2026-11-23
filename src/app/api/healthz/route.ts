// NFR-27: touches no database.
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/healthz', auth: 'none' }, async () => ({ ok: true }));
