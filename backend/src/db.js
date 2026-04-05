import { MongoClient } from 'mongodb';
import { config } from './config.js';

let client;
let db;
let connectPromise;

async function ensureIndexes(database) {
  await Promise.all([
    database.collection('users').createIndex({ username: 1 }),
    database.collection('users').createIndex({ address: 1 }, { unique: true, sparse: true }),
    database.collection('users').createIndex({ lastSeen: -1 }),
    database.collection('chats').createIndex({ participants: 1 }),
    database.collection('chats').createIndex({ lastMessageTime: -1 }),
    database.collection('messages').createIndex({ chatId: 1, timestamp: 1 }),
    database.collection('nonces').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    database.collection('contacts').createIndex({ ownerId: 1, createdAt: 1 }),
    database.collection('contacts').createIndex({ ownerId: 1, contactId: 1 }, { unique: true }),
  ]);
}

async function stripLegacySecretFields(database) {
  await Promise.all([
    database.collection('users').updateMany(
      { secretKey: { $exists: true } },
      { $unset: { secretKey: '' } }
    ),
    database.collection('contacts').updateMany(
      { secretKey: { $exists: true } },
      { $unset: { secretKey: '' } }
    ),
  ]);
}

export async function connectDb() {
  if (db) return db;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    client = new MongoClient(config.mongodbUri);
    await client.connect();
    db = client.db(config.mongodbDbName);
    await ensureIndexes(db);
    await stripLegacySecretFields(db);
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
