/**
 * Routing helper for launching the next mission of a campaign run. The
 * choice between DeployScene (player-only pre-battle placement) and
 * BattleScene (skip deploy) is data-driven:
 *
 *   - Map has at least one Zone-A polygon → DeployScene first
 *   - Map has no Zone-A → fall back to mission.playerSpawnPositions
 *
 * Both RoundSetupScene (stage 0 launch) and HubScene (mid-chain launch)
 * call into this so the decision lives in one place.
 */
import { getMap, getMissionDef } from '../config/loader';
import type { RunState } from './state';

export const nextMissionNeedsDeployScene = (run: RunState): boolean => {
  const idx = run.missionIndex;
  const mid = run.missionIds[idx];
  if (!mid) return false;
  const mission = getMissionDef(mid);
  const map = getMap(mission.mapId);
  return map.deploymentZones.some((z) => z.faction === 'A');
};
