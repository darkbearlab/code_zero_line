/**
 * Headless A/B sim driver.
 *
 *   npm run sim -- --aiA greedy --aiB greedy --matches 200 --seed-base sim
 *
 * Runs `matches` independent simulations with seeds derived from `seed-base`,
 * prints aggregate KPIs, and writes the full outcomes to logs/sim-<ts>.json.
 *
 * Determinism: identical args yield identical output. Re-running with the same
 * seed-base produces a byte-identical log file (great for diffing across AI
 * code changes — anything that drifts is genuine signal, not noise).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAi } from '../ai/index';
import {
  listUnitTemplates,
  listWeapons,
  registerRuntimeMaps,
} from '../config/loader';
import type { EditorMapDoc } from '../config/mapDoc';
import { aggregateKpi } from './metrics';
import { buildFixtureState, namedFixtures } from './fixtures';
import { simulateMatch, type MatchOutcome } from './runMatch';

interface CliArgs {
  aiA: string;
  aiB: string;
  matches: number;
  seedBase: string;
  maxCommands: number;
  fixture: string;
  mapsFile: string | null;
  mapId: string | null;
  scenario: 'elimination' | 'engage-reach';
  /**
   * Combat-intel shoot levels per tag, parsed from `--combat-intel-shoot
   * INFANTRY=3,HEAVY=2`. Empty when flag absent.
   */
  combatIntelShoot: Record<string, number>;
  combatIntelMelee: Record<string, number>;
}

/**
 * Parse `INFANTRY=3,HEAVY=2` into `{ INFANTRY: 3, HEAVY: 2 }`. Bare tags
 * (no `=`) default to level 1.
 */
const parseTagLevels = (raw: string): Record<string, number> => {
  const out: Record<string, number> = {};
  if (!raw) return out;
  for (const part of raw.split(/[,;]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) {
      out[trimmed] = 1;
    } else {
      const tag = trimmed.slice(0, eq).trim();
      const lvl = Math.max(0, Math.floor(Number(trimmed.slice(eq + 1).trim())));
      if (tag) out[tag] = lvl;
    }
  }
  return out;
};

const parseArgs = (argv: ReadonlyArray<string>): CliArgs => {
  const out: CliArgs = {
    aiA: 'greedy',
    aiB: 'greedy',
    matches: 100,
    seedBase: 'sim',
    maxCommands: 5000,
    fixture: 'mirror',
    mapsFile: null,
    mapId: null,
    scenario: 'elimination',
    combatIntelShoot: {},
    combatIntelMelee: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--aiA':
        out.aiA = String(v);
        i++;
        break;
      case '--aiB':
        out.aiB = String(v);
        i++;
        break;
      case '--matches':
        out.matches = Math.max(1, Math.floor(Number(v)));
        i++;
        break;
      case '--seed-base':
        out.seedBase = String(v);
        i++;
        break;
      case '--max-commands':
        out.maxCommands = Math.max(100, Math.floor(Number(v)));
        i++;
        break;
      case '--fixture':
        out.fixture = String(v);
        i++;
        break;
      case '--maps-file':
        out.mapsFile = String(v);
        i++;
        break;
      case '--map':
        out.mapId = String(v);
        i++;
        break;
      case '--scenario': {
        const s = String(v);
        if (s !== 'elimination' && s !== 'engage-reach') {
          process.stderr.write(
            `Unknown scenario "${s}". Available: elimination, engage-reach\n`,
          );
          process.exit(2);
        }
        out.scenario = s;
        i++;
        break;
      }
      case '--combat-intel-shoot':
        out.combatIntelShoot = parseTagLevels(String(v));
        i++;
        break;
      case '--combat-intel-melee':
        out.combatIntelMelee = parseTagLevels(String(v));
        i++;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (k?.startsWith('--')) {
          process.stderr.write(`Unknown flag: ${k}\n`);
          printHelp();
          process.exit(2);
        }
        break;
    }
  }
  return out;
};

const printHelp = (): void => {
  process.stdout.write(
    [
      'Usage: npm run sim -- [flags]',
      '',
      '  --aiA <name>          AI for faction A (default: greedy)',
      '  --aiB <name>          AI for faction B (default: greedy)',
      '  --matches <n>         Number of matches (default: 100)',
      '  --seed-base <s>       Seed prefix; per-match seed = <prefix>-<i>',
      '  --max-commands <n>    Hard cap per match (default: 5000)',
      '  --fixture <name>      mirror | demo  (default: mirror — symmetric loadout)',
      '  --maps-file <path>    Load editor map docs from JSON (e.g. exported',
      '                        from browser localStorage[czl.editor.maps.v1]).',
      '  --map <id>            Override the fixture\'s map (defaults to fixture\'s).',
      '  --scenario <name>     elimination | engage-reach (default: elimination)',
      '  --combat-intel-shoot <levels>   Player-side dice-threshold reductions',
      '                                  by tag, e.g. INFANTRY=3,HEAVY=2',
      '                                  (default: empty — Phase A behaviour)',
      '  --combat-intel-melee <levels>   Same shape, melee track',
      '',
      'Output: console summary table + logs/sim-<timestamp>.json',
      '',
    ].join('\n'),
  );
};

/**
 * Cheap content-defined ruleset stamp. Rebuilt every time loader output
 * changes (custom weapons / templates from localStorage etc.). 8 hex chars
 * is more than enough for human-readable comparison; collisions don't matter
 * because mismatches just trigger a "may not be comparable" warning, not a
 * correctness bug.
 */
const computeRulesetVersion = (): string => {
  const blob = JSON.stringify({
    weapons: listWeapons(),
    templates: listUnitTemplates(),
  });
  let h = 2166136261;
  for (let i = 0; i < blob.length; i++) {
    h ^= blob.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

const fmtPct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const fmt = (x: number, digits = 2): string => x.toFixed(digits);

const run = (): void => {
  const args = parseArgs(process.argv.slice(2));

  if (args.mapsFile) {
    const raw = readFileSync(args.mapsFile, 'utf8');
    const parsed = JSON.parse(raw) as EditorMapDoc[] | EditorMapDoc;
    const docs = Array.isArray(parsed) ? parsed : [parsed];
    registerRuntimeMaps(docs);
    process.stdout.write(
      `loaded ${docs.length} map(s) from ${args.mapsFile}: ${docs.map((d) => d.id).join(', ')}\n`,
    );
  }

  const aiA = getAi(args.aiA);
  const aiB = getAi(args.aiB);
  const rulesetVersion = computeRulesetVersion();

  const baseFixture = namedFixtures[args.fixture];
  if (!baseFixture) {
    process.stderr.write(
      `Unknown fixture "${args.fixture}". Available: ${Object.keys(namedFixtures).join(', ')}\n`,
    );
    process.exit(2);
  }
  const fixture = args.mapId
    ? { ...baseFixture, mapId: args.mapId }
    : baseFixture;

  const hasCombatIntel =
    Object.keys(args.combatIntelShoot).length > 0 ||
    Object.keys(args.combatIntelMelee).length > 0;
  const combatIntel = hasCombatIntel
    ? { shoot: args.combatIntelShoot, melee: args.combatIntelMelee }
    : undefined;

  const t0 = Date.now();
  const outcomes: MatchOutcome[] = [];
  for (let i = 0; i < args.matches; i++) {
    const seed = `${args.seedBase}-${i}`;
    const baseInitial = buildFixtureState(fixture, seed);
    const initial = combatIntel
      ? { ...baseInitial, combatIntel }
      : baseInitial;
    const outcome = simulateMatch(initial, aiA, aiB, {
      maxCommands: args.maxCommands,
      rulesetVersion,
      scenario: args.scenario,
    });
    outcomes.push(outcome);
  }
  const elapsedMs = Date.now() - t0;

  const agg = aggregateKpi(outcomes);

  const lines: string[] = [];
  lines.push(
    `── A=${args.aiA} vs B=${args.aiB} on "${args.fixture}" map=${fixture.mapId} scenario=${args.scenario} — ${agg.matches} matches (ruleset ${rulesetVersion}, ${elapsedMs}ms) ──`,
  );
  lines.push(
    `win rate            A: ${fmtPct(agg.winRateA)}   B: ${fmtPct(agg.winRateB)}   draw: ${fmtPct((agg.draws / Math.max(1, agg.matches)))}`,
  );
  lines.push(
    `avg                 rounds: ${fmt(agg.avgRounds)}   commands: ${fmt(agg.avgCommandCount, 1)}`,
  );
  const reasons = Object.entries(agg.endReasonCounts)
    .map(([r, n]) => `${r}=${n}`)
    .join('  ');
  lines.push(`end reasons         ${reasons}`);
  lines.push('');
  lines.push(
    `shots / match       A: ${fmt(agg.A.shotsPerMatch, 1)} (${fmtPct(agg.A.hitRate)} hit)   B: ${fmt(agg.B.shotsPerMatch, 1)} (${fmtPct(agg.B.hitRate)} hit)`,
  );
  lines.push(
    `reaction shots      A: ${fmt(agg.A.reactionShotsPerMatch, 2)}   B: ${fmt(agg.B.reactionShotsPerMatch, 2)}`,
  );
  lines.push(
    `move dist / match   A: ${fmt(agg.A.moveDistancePerMatch, 0)}px   B: ${fmt(agg.B.moveDistancePerMatch, 0)}px`,
  );
  lines.push(
    `rally / match       A: ${fmt(agg.A.rallyAttemptsPerMatch, 2)} (${fmtPct(agg.A.rallySuccessRate)} ok)   B: ${fmt(agg.B.rallyAttemptsPerMatch, 2)} (${fmtPct(agg.B.rallySuccessRate)} ok)`,
  );
  lines.push(
    `overdrafts / match  A: ${fmt(agg.A.overdraftPerMatch, 2)}   B: ${fmt(agg.B.overdraftPerMatch, 2)}`,
  );
  lines.push(
    `units lost / match  A: ${fmt(agg.A.unitsLostPerMatch, 2)}   B: ${fmt(agg.B.unitsLostPerMatch, 2)}`,
  );
  // Officer ability usage — totals over the whole batch (per match = total / N).
  const sumAB = (
    pick: (o: MatchOutcome) => { A: number; B: number },
  ): { A: number; B: number } => {
    let a = 0;
    let b = 0;
    for (const o of outcomes) {
      a += pick(o).A;
      b += pick(o).B;
    }
    return { A: a, B: b };
  };
  const cmdMoves = sumAB((o) => o.commandMoves);
  const cmdRallies = sumAB((o) => o.commandRallies);
  const combined = sumAB((o) => o.combinedShots);
  const n = Math.max(1, agg.matches);
  lines.push(
    `command-move /m    A: ${fmt(cmdMoves.A / n, 2)}   B: ${fmt(cmdMoves.B / n, 2)}`,
  );
  lines.push(
    `command-rally /m   A: ${fmt(cmdRallies.A / n, 2)}   B: ${fmt(cmdRallies.B / n, 2)}`,
  );
  lines.push(
    `combined fire /m   A: ${fmt(combined.A / n, 2)}   B: ${fmt(combined.B / n, 2)}`,
  );
  process.stdout.write(lines.join('\n') + '\n');

  // Persist per-match data for offline analysis.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..');
  const logsDir = resolve(repoRoot, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = resolve(logsDir, `sim-${ts}.json`);
  const payload = {
    args,
    rulesetVersion,
    elapsedMs,
    aggregate: agg,
    outcomes: outcomes.map((o) => ({
      winner: o.winner,
      rounds: o.rounds,
      commandCount: o.commandCount,
      reason: o.reason,
    })),
  };
  writeFileSync(file, JSON.stringify(payload, null, 2));
  process.stdout.write(`\nlog: ${file}\n`);
};

run();
