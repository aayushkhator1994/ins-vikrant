import fs from 'node:fs';
import path from 'node:path';
import { SCOUTS } from './scouts.js';

const [kind, missionDir] = process.argv.slice(2);

async function main() {
  if (!SCOUTS[kind] || !missionDir) {
    console.error('usage: node src/scout-worker.js <fundamentals|news|readacross> <missionDir>');
    process.exit(2);
  }
  process.env.MISSION_DIR = missionDir;
  const delay = Number(process.env.SCOUT_DELAY_MS || 0);
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  const brief = JSON.parse(fs.readFileSync(path.join(missionDir, 'brief.json'), 'utf8'));
  const claims = await SCOUTS[kind](brief);
  process.stdout.write('\n' + JSON.stringify({ scout: kind, claims }) + '\n', () => process.exit(0));
}

main().catch((err) => {
  console.error(String((err && err.stack) || err));
  process.exit(1);
});
