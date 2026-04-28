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
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAi } from '../ai/index';
import { listUnitTemplates, listWeapons } from '../config/loader';
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
}

const parseArgs = (argv: ReadonlyArray<string>): CliArgs => {
  const out: CliArgs = {
    aiA: 'greedy',
    aiB: 'greedy',
    matches: 100,
    seedBase: 'sim',
    maxCommands: 5000,
    fixture: 'mirror',
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
  const aiA = getAi(args.aiA);
  const aiB = getAi(args.aiB);
  const rulesetVersion = computeRulesetVersion();

  const fixture = namedFixtures[args.fixture];
  if (!fixture) {
    process.stderr.write(
      `Unknown fixture "${args.fixture}". Available: ${Object.keys(namedFixtures).join(', ')}\n`,
    );
    process.exit(2);
  }

  const t0 = Date.now();
  const outcomes: MatchOutcome[] = [];
  for (let i = 0; i < args.matches; i++) {
    const seed = `${args.seedBase}-${i}`;
    const initial = buildFixtureState(fixture, seed);
    const outcome = simulateMatch(initial, aiA, aiB, {
      maxCommands: args.maxCommands,
      rulesetVersion,
    });
    outcomes.push(outcome);
  }
  const elapsedMs = Date.now() - t0;

  const agg = aggregateKpi(outcomes);

  const lines: string[] = [];
  lines.push(
    `── A=${args.aiA} vs B=${args.aiB} on "${args.fixture}" — ${agg.matches} matches (ruleset ${rulesetVersion}, ${elapsedMs}ms) ──`,
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
