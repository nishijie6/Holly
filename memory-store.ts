import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import YAML from "yaml";

import {
  createQdrantIncomingMessageStore,
  describeErrorChain,
} from "./qdrant-store.js";
import type { IncomingMessageStore } from "./memory-store-types.js";

export {
  isNapCatHeartbeat,
  parseStoredMemoryRecord,
  type IncomingMessageRecord,
  type IncomingMessageStore,
  type InternalMemoryRecord,
  type StoredMemoryRecord,
  type WorldObservationMemoryRecord,
} from "./memory-store-types.js";
export { describeErrorChain } from "./qdrant-store.js";

type DatabaseProvider = "sqlite" | "qdrant";

type AppConfig = {
  database?: {
    enabled?: boolean;
    provider?: string;
  };
};

async function resolveDatabaseProvider(configPath: string): Promise<{
  enabled: boolean;
  provider: DatabaseProvider;
}> {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}.`);
  }

  const config = ((YAML.parse(await readFile(configPath, "utf8")) as AppConfig | null) ?? {});
  const database = config.database;
  if (!database) {
    // Backward compatibility for existing installations that only have the
    // historical `qdrant` section.
    return { enabled: true, provider: "qdrant" };
  }

  const provider = (database.provider?.trim().toLowerCase() || "sqlite") as DatabaseProvider;
  if (provider !== "sqlite" && provider !== "qdrant") {
    throw new Error(`Invalid 'database.provider' in ${configPath}: ${database.provider}.`);
  }
  return {
    enabled: database.enabled ?? true,
    provider,
  };
}

export async function createIncomingMessageStore(
  configPath: string,
  options: {
    sessionId?: string;
    sessionStartedAt?: string;
    wsTargetUrl?: string;
  } = {},
): Promise<IncomingMessageStore | null> {
  const database = await resolveDatabaseProvider(configPath);
  if (!database.enabled) return null;

  if (database.provider === "qdrant") {
    return createQdrantIncomingMessageStore(configPath, options);
  }

  try {
    const { createSqliteIncomingMessageStore } = await import("./sqlite-store.js");
    return createSqliteIncomingMessageStore(configPath, options);
  } catch (error) {
    throw new Error(`Unable to initialize local SQLite store: ${describeErrorChain(error)}`, {
      cause: error,
    });
  }
}
