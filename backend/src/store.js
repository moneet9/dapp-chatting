import { randomUUID } from 'crypto';
import { connectDb } from './db.js';
import { getOpaqueNonceId, getOpaqueUserId, normalizeWalletAddress } from './privacy.js';

const NONCE_TTL_MS = 5 * 60 * 1000;

function toClientDocument(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

function toClientDocuments(docs) {
  return docs.map(toClientDocument);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getDirectChatKey(chat) {
  if (chat.type !== 'direct' || !Array.isArray(chat.participants)) return null;
  const participants = [...new Set(chat.participants)].sort();
  if (participants.length !== 2) return null;
  return `direct:${participants[0]}:${participants[1]}`;
}

async function getCollections() {
  const db = await connectDb();
  return {
    users: db.collection('users'),
    chats: db.collection('chats'),
    messages: db.collection('messages'),
    nonces: db.collection('nonces'),
    contacts: db.collection('contacts'),
  };
}

export async function issueNonce(address) {
  const { nonces } = await getCollections();
  const wallet = normalizeWalletAddress(address);
  const nonceId = getOpaqueNonceId(wallet);
  const nonce = randomUUID().replace(/-/g, '').slice(0, 16);

  await nonces.updateOne(
    { _id: nonceId },
    {
      $set: {
        nonce,
        expiresAt: new Date(Date.now() + NONCE_TTL_MS),
      },
    },
    { upsert: true }
  );

  return nonce;
}

export async function getNonceRecord(address) {
  const { nonces } = await getCollections();
  const wallet = normalizeWalletAddress(address);
  const nonceId = getOpaqueNonceId(wallet);
  const record = await nonces.findOne({ _id: nonceId });
  if (!record) return null;

  return {
    nonce: record.nonce,
    expiresAt:
      record.expiresAt instanceof Date
        ? record.expiresAt.getTime()
        : Number(record.expiresAt || 0),
  };
}

export async function clearNonce(address) {
  const { nonces } = await getCollections();
  const wallet = normalizeWalletAddress(address);
  const nonceId = getOpaqueNonceId(wallet);
  await nonces.deleteOne({ _id: nonceId });
}

function normalizeUsername(username, fallbackWallet) {
  const trimmed = String(username || '').trim();
  if (trimmed.length >= 2 && trimmed.length <= 32) {
    return trimmed;
  }
  return `User-${fallbackWallet.slice(2, 8)}`;
}

function buildPublicUser(doc, address) {
  const publicUser = toClientDocument(doc);
  if (address) {
    publicUser.address = normalizeWalletAddress(address);
  }
  return publicUser;
}

export async function upsertUser(address, options = {}) {
  const { users } = await getCollections();
  const wallet = normalizeWalletAddress(address);
  const userId = getOpaqueUserId(wallet);
  const now = Date.now();
  const username = normalizeUsername(options.preferredUsername, wallet);

  await users.updateOne(
    { _id: userId },
    {
      $setOnInsert: {
        _id: userId,
        id: userId,
        username,
      },
      $set: {
        status: 'online',
        lastSeen: now,
      },
    },
    { upsert: true }
  );

  const user = await users.findOne({ _id: userId });
  return buildPublicUser(user, wallet);
}

export async function getUserById(userId) {
  const { users } = await getCollections();
  const user = await users.findOne({ _id: userId });
  return toClientDocument(user);
}

export async function updateUsername(userId, username) {
  const nextUsername = String(username || '').trim();
  if (nextUsername.length < 2 || nextUsername.length > 32) {
    return { error: 'Username must be between 2 and 32 characters' };
  }

  const { users } = await getCollections();
  const result = await users.updateOne(
    { _id: userId },
    {
      $set: {
        username: nextUsername,
        lastSeen: Date.now(),
      },
    }
  );

  if (!result.matchedCount) {
    return { error: 'User not found' };
  }

  const user = await users.findOne({ _id: userId });
  return { user: toClientDocument(user) };
}

export async function setUserStatus(userId, status) {
  const { users } = await getCollections();
  const result = await users.updateOne(
    { _id: userId },
    {
      $set: {
        status,
        lastSeen: Date.now(),
      },
    }
  );

  if (!result.matchedCount) return null;
  const user = await users.findOne({ _id: userId });
  return toClientDocument(user);
}

export async function listUsers() {
  const { users } = await getCollections();
  const docs = await users.find({}).sort({ lastSeen: -1 }).toArray();
  return toClientDocuments(docs);
}

export async function listContacts(ownerId) {
  const { contacts, users } = await getCollections();
  const contactDocs = await contacts.find({ ownerId }).sort({ createdAt: 1 }).toArray();
  if (contactDocs.length === 0) return [];

  const contactIds = contactDocs.map((contact) => contact.contactId);
  const userDocs = await users.find({ _id: { $in: contactIds } }).toArray();
  const userById = new Map(userDocs.map((userDoc) => [userDoc._id, toClientDocument(userDoc)]));

  return contactDocs
    .map((contact) => userById.get(contact.contactId))
    .filter(Boolean);
}

export async function addContact(ownerId, contactAddress, preferredUsername) {
  const { contacts } = await getCollections();
  const normalizedAddress = normalizeWalletAddress(contactAddress);
  const contactUser = await upsertUser(normalizedAddress, { preferredUsername });

  if (ownerId === contactUser.id) {
    return { error: 'You cannot add yourself as a contact' };
  }

  const id = `${ownerId}:${contactUser.id}`;

  await contacts.updateOne(
    { _id: id },
    {
      $setOnInsert: {
        _id: id,
        ownerId,
        contactId: contactUser.id,
        createdAt: Date.now(),
      },
    },
    { upsert: true }
  );

  const { address: _address, ...contactWithoutAddress } = contactUser;
  return { contact: contactWithoutAddress };
}

export async function searchUsers(query) {
  const q = query.trim();
  if (!q) return listUsers();

  const { users } = await getCollections();
  const regex = new RegExp(escapeRegex(q), 'i');
  const docs = await users.find({ username: regex }).toArray();
  return toClientDocuments(docs);
}

export async function listChatsForUser(userId) {
  const { chats } = await getCollections();
  const docs = await chats.find({ participants: userId }).sort({ lastMessageTime: -1 }).toArray();

  const seenDirectKeys = new Set();
  const uniqueDocs = [];
  for (const chat of docs) {
    const directKey = getDirectChatKey(chat);
    if (directKey) {
      if (seenDirectKeys.has(directKey)) continue;
      seenDirectKeys.add(directKey);
    }
    uniqueDocs.push(chat);
  }

  return toClientDocuments(uniqueDocs);
}

export async function getChat(chatId) {
  const { chats } = await getCollections();
  const chat = await chats.findOne({ _id: chatId });
  return toClientDocument(chat);
}

export async function createChat(payload, createdBy) {
  const { chats } = await getCollections();
  const participants = [...new Set(payload.participants)];

  if (payload.type === 'direct') {
    const directParticipants = participants.slice(0, 2);
    if (directParticipants.length === 2) {
      const existingDirectChat = await chats.findOne({
        type: 'direct',
        participants: { $all: directParticipants },
        $expr: { $eq: [{ $size: '$participants' }, 2] },
      });

      if (existingDirectChat) {
        return toClientDocument(existingDirectChat);
      }
    }
  }

  const chatId = `chat-${randomUUID()}`;
  const now = Date.now();
  const chat = {
    _id: chatId,
    id: chatId,
    type: payload.type,
    participants: payload.type === 'direct' ? participants.slice(0, 2) : participants,
    lastMessageTime: now,
    unreadCount: 0,
    createdAt: now,
    encryptionKey: payload.encryptionKey || '',
  };

  if (payload.type === 'group') {
    chat.name = payload.name || 'New Group';
    chat.description = payload.description || '';
    chat.admins = [createdBy];
    chat.createdBy = createdBy;
  }

  await chats.insertOne(chat);
  return toClientDocument(chat);
}

export async function updateGroup(payload, currentUserId) {
  const { chats } = await getCollections();
  const chat = await chats.findOne({ _id: payload.chatId });
  if (!chat) return { error: 'Chat not found' };
  if (chat.type !== 'group') return { error: 'Not a group chat' };
  if (!chat.admins.includes(currentUserId)) return { error: 'Only admin can update group' };

  const updates = {};
  if (payload.name !== undefined) updates.name = payload.name;
  if (payload.description !== undefined) updates.description = payload.description;
  if (payload.avatar !== undefined) updates.avatar = payload.avatar;

  if (Object.keys(updates).length > 0) {
    await chats.updateOne({ _id: payload.chatId }, { $set: updates });
  }

  const updatedChat = await chats.findOne({ _id: payload.chatId });
  return { chat: toClientDocument(updatedChat) };
}

export async function addParticipants(chatId, userIds, currentUserId) {
  const { chats } = await getCollections();
  const chat = await chats.findOne({ _id: chatId });
  if (!chat) return { error: 'Chat not found' };
  if (chat.type !== 'group') return { error: 'Not a group chat' };
  if (!chat.admins.includes(currentUserId)) return { error: 'Only admin can add participants' };

  await chats.updateOne(
    { _id: chatId },
    {
      $addToSet: {
        participants: { $each: userIds },
      },
    }
  );

  const updatedChat = await chats.findOne({ _id: chatId });
  return { chat: toClientDocument(updatedChat) };
}

export async function removeParticipant(chatId, userId, currentUserId) {
  const { chats } = await getCollections();
  const chat = await chats.findOne({ _id: chatId });
  if (!chat) return { error: 'Chat not found' };
  if (chat.type !== 'group') return { error: 'Not a group chat' };
  if (!chat.admins.includes(currentUserId)) return { error: 'Only admin can remove participants' };

  await chats.updateOne(
    { _id: chatId },
    {
      $pull: {
        participants: userId,
        admins: userId,
      },
    }
  );

  const updatedChat = await chats.findOne({ _id: chatId });
  return { chat: toClientDocument(updatedChat) };
}

export async function getMessages(chatId) {
  const { messages } = await getCollections();
  const docs = await messages.find({ chatId }).sort({ timestamp: 1 }).toArray();
  return toClientDocuments(docs);
}

export async function saveMessage(payload, senderId) {
  const { chats, messages } = await getCollections();
  const chat = await chats.findOne({ _id: payload.chatId });
  if (!chat) {
    return { error: 'Chat not found' };
  }
  if (!chat.participants.includes(senderId)) {
    return { error: 'User is not part of this chat' };
  }

  const messageId = payload.tempId || `msg-${randomUUID()}`;
  const message = {
    _id: messageId,
    id: messageId,
    chatId: payload.chatId,
    senderId,
    timestamp: Date.now(),
    status: 'sent',
    type: payload.type,
    encryptedContent: payload.encryptedContent,
    replyTo: payload.replyTo,
  };

  if (payload.type !== 'text') {
    message.fileName = payload.fileName;
    message.fileSize = payload.fileSize;
    message.mimeType = payload.mimeType;
    message.encryptedUrl = payload.encryptedUrl;
  }

  await messages.insertOne(message);

  const lastMessage = toClientDocument(message);
  await chats.updateOne(
    { _id: payload.chatId },
    {
      $set: {
        lastMessage,
        lastMessageTime: message.timestamp,
      },
    }
  );

  return { message: lastMessage };
}
