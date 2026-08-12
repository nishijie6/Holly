import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { copyQdrantPayloads } from "./qdrant-store.js";
import { openSqlitePayloadRepository } from "./sqlite-store.js";

const APP_ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CONFIG_PATH?.trim() || join(APP_ROOT, "config.yaml");

async function migrate(): Promise<void> {
  const repository = await openSqlitePayloadRepository(CONFIG_PATH);
  const before = repository.count();
  let inserted = 0;
  let processed = 0;

  try {
    const scanned = await copyQdrantPayloads(CONFIG_PATH, (records) => {
      for (const record of records) {
        if (repository.insertPayload(record.id, record.payload)) inserted += 1;
      }
      processed += records.length;
      process.stdout.write(`\rScanned ${processed} candidate record(s)...`);
    });
    process.stdout.write("\n");
    console.log(
      `Qdrant -> SQLite migration complete: scanned=${scanned}, inserted=${inserted}, existing=${before}, total=${repository.count()}, database=${repository.databasePath}`,
    );
  } finally {
    repository.close();
  }
}

void migrate().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
