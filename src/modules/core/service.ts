// Core's public service interface for the other modules (ARC-01, ARC-03). Feedback Hub and Journey Boards
// import Core only through this file; the lint rule in eslint.config.mjs refuses any other Core path.
export type { Principal } from './auth/principal';
export { audit, type AuditEntry } from './audit';
export { enqueue, registerJob, drainJobs } from './jobs';
export { publish, publishMany, registerChannelRule } from './realtime';
export { getSettings, type Settings } from './settings';
export { deleteFiles, signFileUrls, registerFileOwnerResolver } from './files/service';
export { newId } from './util';
