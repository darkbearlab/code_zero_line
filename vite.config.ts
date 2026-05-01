import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const BUNDLE_SAVE_PATH = '/__bundle/save';
const VALID_ID = /^[a-z0-9][a-z0-9\-_]*[a-z0-9]$|^[a-z0-9]$/i;
const TYPE_TO_DIR: Record<string, string> = {
  weapon: 'weapons',
  unit: 'units',
  map: 'maps',
  mission: 'missions',
  faction: 'factions',
};

function bundleSavePlugin(): Plugin {
  return {
    name: 'bundle-save',
    configureServer(server) {
      server.middlewares.use(BUNDLE_SAVE_PATH, (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end('Method Not Allowed');
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body) as {
              type?: string;
              id?: string;
              op?: 'upsert' | 'delete';
              data?: unknown;
            };
            const { type, id, data } = parsed;
            const op = parsed.op ?? 'upsert';
            if (!type || !(type in TYPE_TO_DIR)) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: `Unknown type '${type}'.` }));
              return;
            }
            if (!id || !VALID_ID.test(id)) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: `Invalid id '${id}'. Use letters, digits, hyphens, underscores.` }));
              return;
            }
            const dir = join(
              process.cwd(),
              'src',
              'config',
              TYPE_TO_DIR[type],
            );
            const filePath = join(dir, `${id}.json`);
            if (op === 'delete') {
              if (existsSync(filePath)) unlinkSync(filePath);
              execSync('node scripts/gen-bundles.mjs', { cwd: process.cwd() });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, op: 'delete', path: `src/config/${TYPE_TO_DIR[type]}/${id}.json` }));
              return;
            }
            // upsert
            if (!data || typeof data !== 'object') {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Missing data.' }));
              return;
            }
            mkdirSync(dir, { recursive: true });
            writeFileSync(
              filePath,
              JSON.stringify(data, null, 2) + '\n',
            );
            execSync('node scripts/gen-bundles.mjs', { cwd: process.cwd() });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, op: 'upsert', path: `src/config/${TYPE_TO_DIR[type]}/${id}.json` }));
          } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: String(e) }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [bundleSavePlugin()],
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        editor: resolve(__dirname, 'editor.html'),
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});
