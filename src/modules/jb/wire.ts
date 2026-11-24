// Request schemas for Journey Boards routes. Kind data is validated by the registry, not here,
// and unknown keys survive (JB-304), so data objects are open records.
import { z } from 'zod';
import { MAX_OPS_PER_BATCH } from './ops';

export const LocalId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Ids are 1 to 64 letters, digits, - or _.');
export const BoardId = z.uuid();
const SortKey = z.string().regex(/^[0-9A-Za-z]{1,64}$/).refine((k) => !k.endsWith('0'), 'Bad sort key.');
const Num = z.number().finite().min(-1e7).max(1e7);
const Obj = z.record(z.string().max(100), z.unknown());
const Option = z.strictObject({ id: LocalId, label: z.string().min(1).max(80), colour: z.string().regex(/^[a-z]{3,12}$/) });
const Entity = z.enum(['node', 'edge', 'field']);
const Base = z.number().int().min(0).optional();

const NodeValue = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9-]*$/), x: Num, y: Num, width: Num.positive().nullable().optional(),
  height: Num.positive().nullable().optional(), zIndex: z.number().int().min(-1000).max(1000).nullable().optional(), sortKey: SortKey, data: Obj,
});
const EdgeValue = z.object({ source: LocalId, target: LocalId, sortKey: SortKey, data: Obj.optional() });
const FieldValue = z.object({
  kind: z.enum(['picker', 'text', 'toggle', 'date']), label: z.string().min(1).max(80), options: z.array(Option).max(50).optional(),
  showOnCard: z.boolean().optional(), sortKey: SortKey, presetKey: z.string().max(40).nullable().optional(), extra: Obj.optional(),
});
export const VALUE_SCHEMA = { node: NodeValue, edge: EdgeValue, field: FieldValue } as const;

const NodeSet = z.strictObject({
  x: Num.optional(), y: Num.optional(), width: Num.positive().nullable().optional(), height: Num.positive().nullable().optional(),
  zIndex: z.number().int().min(-1000).max(1000).nullable().optional(), sortKey: SortKey.optional(),
});
const EdgeSet = z.strictObject({ source: LocalId.optional(), target: LocalId.optional(), sortKey: SortKey.optional() });
const FieldSet = z.strictObject({ label: z.string().min(1).max(80).optional(), options: z.array(Option).max(50).optional(), showOnCard: z.boolean().optional(), sortKey: SortKey.optional() });
export const SET_SCHEMA = { node: NodeSet, edge: EdgeSet, field: FieldSet } as const;

export const OpSchema = z.union([
  z.strictObject({ type: Entity, op: z.literal('create'), id: LocalId, value: Obj }),
  z.strictObject({ type: Entity, op: z.literal('patch'), id: LocalId, baseVersion: Base, set: Obj.optional(), data: Obj.optional(), unset: z.array(z.string().max(100)).max(100).optional() }),
  z.strictObject({ type: Entity, op: z.enum(['delete']), id: LocalId, baseVersion: Base }),
  z.strictObject({ type: Entity, op: z.literal('restore'), id: LocalId, baseVersion: Base, value: Obj.optional() }),
  z.strictObject({ type: z.literal('board'), op: z.literal('patch'), name: z.string().min(1).max(200).optional(), settings: Obj.optional(), unsetSettings: z.array(z.string().max(100)).max(50).optional() }),
]);

export const BatchBody = z.strictObject({
  batchId: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),
  clientId: z.string().min(4).max(128).regex(/^[A-Za-z0-9_-]+$/),
  protocol: z.number().int().min(0),
  ops: z.array(z.unknown()).min(1).max(MAX_OPS_PER_BATCH),
});

// ── export / import (JB-1901, JB-1902) ─────────────────────────────────────
export const EXPORT_FORMAT = 'pet.journey-boards';
export const EXPORT_SCHEMA_VERSION = 1;

const ExportNode = NodeValue.extend({ id: LocalId });
const ExportEdge = EdgeValue.extend({ id: LocalId });
const ExportField = FieldValue.extend({ id: LocalId });
const ExportBoardBase = z.object({
  name: z.string().min(1).max(200),
  settings: Obj.optional(),
  fields: z.array(ExportField).max(200),
  nodes: z.array(ExportNode).max(5000),
  edges: z.array(ExportEdge).max(10000),
});
export const ExportBoard = ExportBoardBase.extend({
  journeys: z.array(ExportBoardBase.extend({ journeyOfNodeId: LocalId })).max(200).optional(),
});
export const ExportDoc = z.object({
  format: z.literal(EXPORT_FORMAT),
  schemaVersion: z.number().int().min(1).max(EXPORT_SCHEMA_VERSION),
  boards: z.array(ExportBoard).min(1).max(20),
});
export type ExportDocT = z.infer<typeof ExportDoc>;
export type ExportBoardT = z.infer<typeof ExportBoard>;
