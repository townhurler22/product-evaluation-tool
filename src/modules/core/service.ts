// Core's public service interface (ARC-01, ARC-03). Other modules import Core only through this file;
// the lint rule in eslint.config.mjs refuses any other `@/modules/core/*` import from fh or jb.
export type { Principal, Role } from './auth/principal';
export { audit, type AuditEntry } from './audit';
export { newId, sha256 } from './util';
export { registerJob, enqueue } from './jobs';
export { registerChannelRule, publish } from './realtime';
export {
  registerShareResolver, type ShareLinkRow, type ResolvedTarget, type ShareContext,
} from './share/pipeline';
export { registerShareManagePolicy } from './share/links';
export {
  prepareUpload, insertFileRows, discardUploads, deleteFiles, signFileUrls, registerFileOwnerResolver, type PreparedFile,
} from './files/service';
