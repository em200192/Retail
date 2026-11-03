import { loadConfig } from '../config.ts';
import { LogEmailAdapter, type MessageChannelAdapter } from '../integrations/adapters.ts';
import { LocalFileStore } from '../integrations/files.ts';
import { createOcrProvider } from '../integrations/ocr.ts';
import { createPool, Db } from '../lib/db.ts';
import { publishOutbox, refreshRecentSummaries, sendOutboundMessages, type WorkerDeps } from './jobs.ts';

const config = loadConfig();
const db = new Db(createPool(config.databaseUrl, { max: 4 }), createPool(config.workerDatabaseUrl, { max: 4 }));
const deps: WorkerDeps = {
  db,
  ocr: createOcrProvider(config),
  files: new LocalFileStore(process.env.FILE_STORE_DIR ?? './.files'),
  messages: new Map<string, MessageChannelAdapter>([['email', new LogEmailAdapter()]]),
  delivery: new Map(),
  log: (msg, extra) => console.error(msg, extra),
};

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

const SUMMARY_EVERY_MS = 5 * 60 * 1000;
let lastSummary = 0;
console.log('worker started');
while (!stopping) {
  try {
    const r = await publishOutbox(deps);
    await sendOutboundMessages(deps);
    if (Date.now() - lastSummary > SUMMARY_EVERY_MS) {
      await refreshRecentSummaries(db);
      lastSummary = Date.now();
    }
    if (r.published + r.failed === 0) await new Promise((res) => setTimeout(res, 1000));
  } catch (err) {
    console.error('worker loop error', err);
    await new Promise((res) => setTimeout(res, 5000));
  }
}
await db.close();
