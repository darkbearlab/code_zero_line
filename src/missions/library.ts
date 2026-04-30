/**
 * Mission registry — thin wrapper over `config/loader`.
 *
 * Each mission lives as a single JSON file in `src/config/missions/`.
 * Adding a new mission = drop a `<id>.json` in that folder; codegen
 * (`npm run gen-bundles`, runs on predev/prebuild) updates the manifest.
 *
 * The localStorage overlay at `czl.editor.missions.v1` lets the (forthcoming)
 * mission editor draft missions in the browser without touching disk.
 */
import {
  listMissionDefs,
  listBundledMissionDefs,
  getMissionDef,
} from '../config/loader';
import type { MissionDef } from './types';

/** All missions visible to the run picker (bundled + custom). */
export const MISSION_LIBRARY_V1: ReadonlyArray<MissionDef> = listMissionDefs();

export const listBundledMissions = (): ReadonlyArray<MissionDef> =>
  listBundledMissionDefs();

export const listAllMissions = (): ReadonlyArray<MissionDef> => listMissionDefs();

/**
 * Subset of missions that the random campaign picker considers.
 *
 * A mission is in the pool unless its `includeInCampaignPool` flag is
 * explicitly `false`. Tutorials, story missions, and editor drafts can opt
 * out without being deleted from the bundle.
 */
export const listCampaignPoolMissions = (): ReadonlyArray<MissionDef> =>
  listMissionDefs().filter((m) => m.includeInCampaignPool !== false);

export const getMissionById = (id: string): MissionDef => getMissionDef(id);
