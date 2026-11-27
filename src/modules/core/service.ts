// Core's public service interface (ARC-01, ARC-03). Feedback Hub and Journey Boards import Core only through
// this file; the lint rule in eslint.config.mjs refuses any other `@/modules/core/*` import from fh or jb.
export type { Principal, Role } from './auth/principal';
export { audit, type AuditEntry } from './audit';
export { newId, sha256 } from './util';
export { enqueue, registerJob, drainJobs } from './jobs';
export { publish, publishMany, registerChannelRule } from './realtime';
export { getSettings, type Settings } from './settings';
export {
  registerShareResolver, type ShareLinkRow, type ResolvedTarget, type ShareContext,
} from './share/pipeline';
export { registerShareManagePolicy } from './share/links';
export {
  prepareUpload, insertFileRows, discardUploads, deleteFiles, signFileUrls, registerFileOwnerResolver, type PreparedFile,
} from './files/service';
// §11.4 link service (ARC-06): the only way Feedback Hub and Journey Boards read or write core_link.
export * as links from './links';
export { registerIntakeRoute, type IntakeClient, type IntakeHandlerResult } from './intake/registry';
export {
  resolveForIntake, normaliseDomain, emailDomain, companyNameKey, type IntakeResolution,
} from './people';
export { registerErasureParticipant, runErasure, type ErasureOutcome } from './erasure';
export { normaliseEmail } from './util';
