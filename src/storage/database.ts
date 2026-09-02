import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { AppError, errorMessage } from "../errors.js";

export const APPLICATION_ID = 1_095_320_404;
export const USER_VERSION = 1;

interface StorageOptions {
  busyTimeoutMs?: number;
}

function verifyMarkers(db: Database.Database, path: string): void {
  const applicationId = db.pragma("application_id", { simple: true });
  const userVersion = db.pragma("user_version", { simple: true });
  if (applicationId !== APPLICATION_ID || userVersion !== USER_VERSION) {
    throw new AppError(
      "incompatible_database",
      `Database ${path} has application_id=${String(applicationId)} user_version=${String(userVersion)}; expected ${APPLICATION_ID}/${USER_VERSION}`,
    );
  }
}

function configureWritable(db: Database.Database): void {
  db.unsafeMode(false);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = FULL");
  db.pragma("trusted_schema = OFF");
}

export async function openStorage(
  path: string,
  options: StorageOptions = {},
): Promise<Database.Database> {
  await mkdir(dirname(path), { recursive: true });
  let initialize: boolean;
  try {
    initialize = (await stat(path)).size === 0;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new AppError(
        "storage_unavailable",
        `Cannot inspect database ${path}: ${errorMessage(error)}`,
      );
    }
    initialize = true;
  }

  const timeout = options.busyTimeoutMs ?? 5_000;
  if (!initialize) {
    const readonly = new Database(path, { readonly: true, fileMustExist: true, timeout });
    try {
      verifyMarkers(readonly, path);
    } finally {
      readonly.close();
    }
  }

  const writable = new Database(path, { timeout, fileMustExist: !initialize });
  if (initialize) {
    const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
    try {
      writable.exec("BEGIN IMMEDIATE");
      writable.exec(schema);
      writable.pragma(`application_id = ${APPLICATION_ID}`);
      writable.pragma(`user_version = ${USER_VERSION}`);
      writable.exec("COMMIT");
    } catch (error) {
      if (writable.inTransaction) {
        writable.exec("ROLLBACK");
      }
      writable.close();
      throw new AppError("storage_initialization_failed", errorMessage(error));
    }
  }

  try {
    verifyMarkers(writable, path);
    configureWritable(writable);
    return writable;
  } catch (error) {
    writable.close();
    throw error;
  }
}

export type StorageDatabase = Database.Database;
