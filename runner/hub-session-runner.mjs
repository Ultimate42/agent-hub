#!/usr/bin/env node
// Lanceur générique : une session Claude continue par agent, alimentée par les messages du salon du hub.
// usage : node runner/hub-session-runner.mjs <config.json> [--dry-run]
import fs from 'node:fs';
import { loadConfig } from './lib.js';
import { Runner, loadSdkQuery } from './runner.js';

const file = process.argv[2];
if (!file) { console.error('usage: hub-session-runner.mjs <config.json> [--dry-run]'); process.exit(2); }
const cfg = loadConfig(file);
if (process.argv.includes('--dry-run')) {
  console.log(`config OK : ${cfg.agents.map((a) => `${a.name}(${a.model})`).join(', ')} -> ${cfg.hubUrl}`);
  process.exit(0);
}
const log = (s) => {
  const line = `[${new Date().toISOString()}] ${s}`;
  console.log(line);
  if (cfg.logFile) fs.appendFileSync(cfg.logFile, line + '\n');
};
const runner = new Runner(cfg, { queryFn: await loadSdkQuery(cfg), log });
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (stopping) return; stopping = true;
    log(`${sig} reçu, arrêt propre`);
    const force = setTimeout(() => process.exit(1), 10000); force.unref();
    await runner.stop();
    process.exit(0);
  });
}
await runner.start();
