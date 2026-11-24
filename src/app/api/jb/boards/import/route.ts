// POST jb/boards/import (JB-1902): validates the file and creates NEW boards; the first error names its path.
import { importBoards } from '@/modules/jb/server/boards';
import { ExportDoc } from '@/modules/jb/wire';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/jb/boards/import', auth: 'required', body: ExportDoc, maxBodyBytes: 8 * 1024 * 1024 },
  async ({ principal, body }) => Response.json({ boards: await importBoards(principal!, body) }, { status: 201 }));
