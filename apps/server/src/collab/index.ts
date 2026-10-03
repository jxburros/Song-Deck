/**
 * Collaboration REST endpoints (the WebSocket itself is attached in server.ts):
 *   GET /api/collab/rooms                          → [{ projectId, peers, revisions }]
 *   GET /api/collab/rooms/:id                      → { projectId, peers, revisions, branches, comments }
 *   GET /api/collab/rooms/:id/revisions/:revId     → Revision (full snapshot)
 */
import { HttpError, sendJson } from '../http-util';
import type { Router } from '../router';
import type { CollabHub } from './hub';

export { CollabHub } from './hub';
export * from './protocol';

export function registerCollabRoutes(router: Router, hub: CollabHub): void {
  router.get('/api/collab/rooms', async ({ res }) => {
    sendJson(res, 200, await hub.listRooms());
  });

  router.get('/api/collab/rooms/:id', async ({ res, params }) => {
    const summary = await hub.roomSummary(params.id);
    if (!summary) throw new HttpError(404, 'not-found', 'Room not found');
    sendJson(res, 200, summary);
  });

  router.get('/api/collab/rooms/:id/revisions/:revId', async ({ res, params }) => {
    const revision = await hub.getRevision(params.id, params.revId);
    if (!revision) throw new HttpError(404, 'not-found', 'Revision not found');
    sendJson(res, 200, revision);
  });
}
