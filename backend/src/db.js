import { MongoClient } from 'mongodb';
import { randomUUID } from 'crypto';
import { config } from './config.js';

let client;
let db;
let connectPromise;

async function ensureIndexes(database) {
  await Promise.all([
    database.collection('users').createIndex({ username: 1 }),
    database.collection('users').createIndex({ address: 1 }, { unique: true, sparse: true }),
    database.collection('users').createIndex({ secretKey: 1 }, { unique: true, sparse: true }),
    database.collection('users').createIndex({ lastSeen: -1 }),
    database.collection('chats').createIndex({ participants: 1 }),
    database.collection('chats').createIndex({ lastMessageTime: -1 }),
    database.collection('messages').createIndex({ chatId: 1, timestamp: 1 }),
    database.collection('nonces').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    database.collection('contacts').createIndex({ ownerId: 1, createdAt: 1 }),
    database.collection('contacts').createIndex({ ownerId: 1, contactId: 1 }, { unique: true }),
  ]);
}

async function backfillSecretKeys(database) {
  const users = database.collection('users');
  const cursor = users.find({ $or: [{ secretKey: { $exists: false } }, { secretKey: '' }, { secretKey: null }] });

  while (await cursor.hasNext()) {
    const user = await cursor.next();
    if (!user?._id) continue;

    await users.updateOne(
      { _id: user._id },
      {
        $set: {
          secretKey: `sk-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        },
      }
    );
  }
}

export async function connectDb() {
  if (db) return db;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    client = new MongoClient(config.mongodbUri);
    await client.connect();
    db = client.db(config.mongodbDbName);
    await ensureIndexes(db);
    await backfillSecretKeys(db);
    console.log(`MongoDB connected: ${config.mongodbDbName}`);
    return db;
  })().catch((error) => {
    connectPromise = undefined;
    throw error;
  });

  return connectPromise;
}

export async function closeDb() {
  if (!client) return;
  await client.close();
  client = undefined;
  db = undefined;
  connectPromise = undefined;
}
