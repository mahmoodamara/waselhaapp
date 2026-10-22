// Logical backup/restore for pilot-sized data, with no tools beyond Node:
//   npm run backup -- <backup-folder>                   dump MONGODB_URI into a new folder
//   npm run restore -- <backup-folder> <target-uri>     restore into an EMPTY database and verify
// Each collection becomes one gzip file with one Extended JSON document per line
// (ObjectIds and dates survive), plus its indexes and a manifest of counts and
// checksums. Restore recreates the indexes - including the unique "one active
// order per driver" index - and refuses to touch a database that already has data.
import mongoose from "mongoose";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createGzip, createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const { EJSON } = mongoose.mongo.BSON;
const sha256 = async (path) => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
};
const collectionsOf = async (db) =>
  (await db.listCollections({ type: "collection" }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system.")).sort();

export async function backupDatabase(db, folder) {
  await mkdir(folder, { recursive: false });
  const manifest = { format: 1, createdAt: new Date().toISOString(), database: db.databaseName, collections: {} };
  for (const name of await collectionsOf(db)) {
    const file = `${name}.ndjson.gz`;
    let count = 0;
    const lines = Readable.from((async function* () {
      for await (const doc of db.collection(name).find({}, { sort: { _id: 1 } })) {
        count++;
        yield `${EJSON.stringify(doc, { relaxed: false })}\n`;
      }
    })());
    await pipeline(lines, createGzip(), createWriteStream(join(folder, file)));
    const indexes = (await db.collection(name).indexes()).filter((i) => i.name !== "_id_");
    manifest.collections[name] = { file, count, sha256: await sha256(join(folder, file)), indexes };
  }
  await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function restoreDatabase(db, folder) {
  const manifest = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"));
  for (const name of await collectionsOf(db))
    if (await db.collection(name).estimatedDocumentCount())
      throw new Error(`Target database is not empty (${name}); restore only into a new database`);
  const existing = new Set(await collectionsOf(db));
  for (const [name, info] of Object.entries(manifest.collections)) {
    if ((await sha256(join(folder, info.file))) !== info.sha256) throw new Error(`Checksum mismatch: ${info.file}`);
    // Inserting no documents creates no namespace; an empty collection still
    // belongs in the restored database even when it has no secondary indexes.
    if (!existing.has(name)) await db.createCollection(name);
    let batch = [];
    const lines = createInterface({ input: createReadStream(join(folder, info.file)).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      batch.push(EJSON.parse(line, { relaxed: false }));
      if (batch.length === 500) {
        await db.collection(name).insertMany(batch, { ordered: false });
        batch = [];
      }
    }
    if (batch.length) await db.collection(name).insertMany(batch, { ordered: false });
    // Indexes last: the unique ones then validate the restored data.
    for (const { key, v, ns, ...options } of info.indexes) await db.collection(name).createIndex(key, options);
  }
  return verifyRestore(db, manifest);
}

// Counts and indexes of the restored database must equal the backup manifest.
export async function verifyRestore(db, manifest) {
  const problems = [];
  const definition = i => ({ key: Object.entries(i.key), unique: i.unique === true, sparse: i.sparse === true,
    partialFilterExpression: i.partialFilterExpression ?? null, expireAfterSeconds: i.expireAfterSeconds ?? null,
    collation: i.collation ?? null });
  for (const [name, info] of Object.entries(manifest.collections)) {
    const count = await db.collection(name).countDocuments();
    if (count !== info.count) problems.push(`${name}: ${count} documents, backup has ${info.count}`);
    const have = new Map((await db.collection(name).indexes()).map(i => [i.name, i]));
    for (const index of info.indexes) {
      const actual = have.get(index.name);
      if (!actual) problems.push(`${name}: index ${index.name} missing`);
      else if (!isDeepStrictEqual(definition(actual), definition(index)))
        problems.push(`${name}: index ${index.name} definition mismatch`);
    }
  }
  if (problems.length) throw new Error(`Restore verification failed:\n- ${problems.join("\n- ")}`);
  return { collections: Object.fromEntries(Object.entries(manifest.collections).map(([n, i]) => [n, i.count])) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, folder, target] = process.argv.slice(2);
  try {
    if (command === "backup" && folder) {
      const { config } = await import("../config.js");
      await mongoose.connect(config.mongoUri);
      const manifest = await backupDatabase(mongoose.connection.db, folder);
      console.log(`Backup written to ${folder}:`, Object.fromEntries(Object.entries(manifest.collections).map(([n, i]) => [n, i.count])));
    } else if (command === "restore" && folder && target) {
      await mongoose.connect(target);
      console.log("RESTORE VERIFIED", await restoreDatabase(mongoose.connection.db, folder));
    } else throw new Error("Usage: backup.js backup <folder> | restore <folder> <target-uri>");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
