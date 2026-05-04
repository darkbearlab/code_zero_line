/**
 * Operation registry — thin wrapper over `config/loader`.
 *
 * Each operation lives as a single JSON file in `src/config/operations/`.
 * Adding a new operation = drop a `<id>.json` in that folder; codegen
 * (`npm run gen-bundles`, runs on predev/prebuild) updates the manifest.
 *
 * The localStorage overlay at `czl.editor.operations.v1` mirrors the
 * mission editor pattern — when an operation editor lands, it can stash
 * drafts there without touching disk.
 */
import {
  listOperationDefs,
  listBundledOperationDefs,
  getOperationDef,
} from '../config/loader';
import type { OperationDef } from './types';

/** All operations visible to the run picker (bundled + custom). */
export const OPERATION_LIBRARY_V1: ReadonlyArray<OperationDef> =
  listOperationDefs();

export const listBundledOperations = (): ReadonlyArray<OperationDef> =>
  listBundledOperationDefs();

export const listAllOperations = (): ReadonlyArray<OperationDef> =>
  listOperationDefs();

/**
 * Subset the random campaign picker considers. Operations opt out by
 * setting `includeInCampaignPool: false` (tutorials, story-only beats,
 * editor drafts).
 */
export const listCampaignPoolOperations = (): ReadonlyArray<OperationDef> =>
  listOperationDefs().filter((o) => o.includeInCampaignPool !== false);

export const getOperationById = (id: string): OperationDef =>
  getOperationDef(id);
