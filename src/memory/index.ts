// src/memory/index.ts
//
// Memory layer barrel export.
// Three-level architecture: L1 (run_scratchpad) + L2 (tenant_memory)
// in this rollout; L3 (shared_knowledge) deferred to its own rollout.

export type {
  MemoryEntry,
  MemoryInput,
  MemoryQuery,
  MemoryType,
  ScratchpadEntry,
  ScratchpadInput,
  MemoryContext,
  SeoMemorySnapshot,
} from './types';

export {
  recordMemory,
  contradictMemory,
  forgetMemory,
  queryMemory,
  getMemoryByKey,
  scratchpadAppend,
  scratchpadReadAll,
  scratchpadReadByKey,
  scratchpadPrune,
  withMemoryTx,
} from './store';

export { getMemoryContext, toPromptString } from './context';
export type { GetMemoryContextOptions } from './context';
