import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createOcrProvider } from './integrations/ocr.ts';
import { createPool, Db } from './lib/db.ts';
import { LocalFileStore } from './integrations/files.ts';

const config = loadConfig();
const db = new Db(createPool(config.databaseUrl), createPool(config.workerDatabaseUrl, { max: 4 }));
const app = await buildApp({ db, config, ocr: createOcrProvider(config), files: new LocalFileStore(process.env.FILE_STORE_DIR ?? './.files') }, { logger: true });

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
