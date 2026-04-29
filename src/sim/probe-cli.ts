/**
 * Connectivity probe CLI.
 *
 *   npm run probe -- --map testmap1 --maps-file maps-local.json
 *
 * Loads a map (custom maps via --maps-file the same way the sim does),
 * runs probeMapTraversal, prints a console summary, and writes the full
 * attempt-by-attempt report to logs/probe-<ts>.json.
 *
 * No game state, no AI, no shooting — just "are A and B reachable from
 * each other on this map and where does pathfinding give up". A failing
 * probe means the map is unplayable, not that the AI is bad.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMap, registerRuntimeMaps } from '../config/loader';
import type { EditorMapDoc } from '../config/mapDoc';
import { probeMapTraversal } from '../ai/pathfinding/probe';

interface CliArgs {
  mapId: string;
  mapsFile: string | null;
  samplesPerZone: number;
  cellSize: number;
}

const parseArgs = (argv: ReadonlyArray<string>): CliArgs => {
  const out: CliArgs = {
    mapId: 'demo',
    mapsFile: null,
    samplesPerZone: 5,
    cellSize: 16,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--map':
        out.mapId = String(v);
        i++;
        break;
      case '--maps-file':
        out.mapsFile = String(v);
        i++;
        break;
      case '--samples':
        out.samplesPerZone = Math.max(1, Math.floor(Number(v)));
        i++;
        break;
      case '--cell-size':
        out.cellSize = Math.max(4, Math.floor(Number(v)));
        i++;
        break;
      case '--help':
      case '-h':
        process.stdout.write(
          [
            'Usage: npm run probe -- [flags]',
            '',
            '  --map <id>            Map to probe (default: demo)',
            '  --maps-file <path>    Load editor map docs from JSON',
            '  --samples <n>         Samples per zone (default: 5 → 25 attempts/dir)',
            '  --cell-size <n>       Grid resolution px (default: 16)',
            '',
          ].join('\n'),
        );
        process.exit(0);
        break;
      default:
        if (k?.startsWith('--')) {
          process.stderr.write(`Unknown flag: ${k}\n`);
          process.exit(2);
        }
        break;
    }
  }
  return out;
};

const fmtPct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const fmt = (x: number, digits = 1): string => x.toFixed(digits);

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

  const map = getMap(args.mapId);
  const t0 = Date.now();
  const report = probeMapTraversal(map, {
    samplesPerZone: args.samplesPerZone,
    cellSize: args.cellSize,
  });
  const elapsedMs = Date.now() - t0;

  const lines: string[] = [];
  lines.push(
    `── probe map=${args.mapId} (${report.mapSize}px, ${report.grid.cols}×${report.grid.rows} grid @ ${args.cellSize}px) ──`,
  );
  lines.push(
    `blocked cells       ${report.grid.blockedCells} / ${report.grid.totalCells} (${fmtPct(
      report.grid.blockedCells / report.grid.totalCells,
    )})`,
  );
  lines.push(`samples per zone    ${args.samplesPerZone}  →  ${args.samplesPerZone ** 2} attempts/direction`);
  lines.push('');
  for (const dir of [report.aToB, report.bToA]) {
    lines.push(
      `${dir.fromFaction} → ${dir.toFaction}             success ${fmtPct(dir.successRate)}   avg dist ${fmt(dir.avgDistance, 0)}px`,
    );
    if (Object.keys(dir.failureReasons).length > 0) {
      const reasons = Object.entries(dir.failureReasons)
        .map(([k, v]) => `${k}=${v}`)
        .join('  ');
      lines.push(`  failure reasons   ${reasons}`);
      const stuck = dir.attempts.filter((a) => !a.success).slice(0, 3);
      for (const s of stuck) {
        lines.push(
          `  stuck sample      from (${fmt(s.from.x, 0)},${fmt(s.from.y, 0)}) to (${fmt(s.to.x, 0)},${fmt(s.to.y, 0)})  reason=${s.stuckReason}`,
        );
      }
    }
  }
  lines.push('');
  lines.push(`elapsed             ${elapsedMs}ms`);
  process.stdout.write(lines.join('\n') + '\n');

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..');
  const logsDir = resolve(repoRoot, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = resolve(logsDir, `probe-${ts}.json`);
  writeFileSync(file, JSON.stringify({ args, elapsedMs, report }, null, 2));
  process.stdout.write(`\nlog: ${file}\n`);
};

run();
