// Experimental implementation of the node:sqlite subset used by this project.
// Scoped to probe bundles until schema, migration and recovery tests pass.
const BetterDatabase = require("better-sqlite3");
const nativeBinding = ["ohos", "openharmony"].includes(process.platform)
  ? "/data/storage/el1/bundle/libs/arm64/better_sqlite3.node"
  : undefined;
function convert(value, bigInts) {
  if (typeof value === "bigint") {
    if (bigInts) return value;
    const number = Number(value);
    if (!Number.isSafeInteger(number))
      throw new RangeError("SQLite integer exceeds safe integer range");
    return number;
  }
  if (Buffer.isBuffer(value) || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => convert(item, bigInts));
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value)) result[key] = convert(item, bigInts);
  return result;
}
function call(operation) {
  try {
    return operation();
  } catch (error) {
    // Legacy schema probes inspect SQLite's extended CHECK error code.
    if (error?.code === "SQLITE_CONSTRAINT_CHECK") error.errcode = 275;
    throw error;
  }
}
class DatabaseSync {
  constructor(file, options = {}) {
    this.database = new BetterDatabase(file, {
      readonly: options.readOnly ?? false,
      timeout: options.timeout ?? 0,
      ...(nativeBinding ? { nativeBinding } : {}),
    });
  }
  exec(sql) {
    call(() => this.database.exec(sql));
  }
  prepare(sql) {
    const statement = call(() => this.database.prepare(sql)).safeIntegers(true);
    let bigInts = false;
    return {
      all: (...values) =>
        call(() => {
          if (statement.reader) return convert(statement.all(...values), bigInts);
          statement.run(...values);
          return [];
        }),
      get: (...values) =>
        call(() => {
          if (statement.reader) return convert(statement.get(...values), bigInts);
          statement.run(...values);
          return undefined;
        }),
      run: (...values) => call(() => convert(statement.run(...values), bigInts)),
      setReadBigInts: (enabled) => {
        bigInts = enabled;
      },
    };
  }
  close() {
    this.database.close();
  }
  [Symbol.dispose]() {
    this.close();
  }
}
function backup(database, destination, options = {}) {
  return database.database
    .backup(destination, {
      progress: ({ totalPages, remainingPages }) => {
        options.progress?.({ totalPages, remainingPages });
        return options.rate ?? 100;
      },
    })
    .then((result) => result.totalPages);
}
module.exports = { DatabaseSync, backup };
