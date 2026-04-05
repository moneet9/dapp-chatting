import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, signToken, verifyLoginSignature } from './auth.js';
import {
  addParticipants,
  addContact,
  createChat,
  getUserById,
  getChat,
  getMessages,
  issueNonce,
  listChatsForUser,
  listContacts,
  listUsers,
  removeParticipant,
  removeContact,
  saveMessage,
  resolveUserBySecretKey,
  searchUsers,
  updateUsername,
  updateGroup,
  upsertUser,
} from './store.js';
import { getSocketServer } from './socket.js';

const loginSchema = z.object({
  address: z.string().startsWith('0x'),
  signature: z.string().min(2),
  message: z.string().min(1),
});

const createChatSchema = z.object({
  type: z.enum(['direct', 'group']),
  participants: z.array(z.string().min(1)).min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  encryptionKey: z.string().optional(),
});

const messageSchema = z.object({
  chatId: z.string().min(1),
  type: z.enum(['text', 'image', 'file']),
  encryptedContent: z.string().min(1),
  fileName: z.string().optional(),
  fileSize: z.number().optional(),
  mimeType: z.string().optional(),
  encryptedUrl: z.string().optional(),
  replyTo: z.string().optional(),
  tempId: z.string().optional(),
});

const updateGroupSchema = z.object({
  chatId: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  avatar: z.string().optional(),
});

const addParticipantsSchema = z.object({
  chatId: z.string().min(1),
  userIds: z.array(z.string().min(1)).min(1),
});

const removeParticipantSchema = z.object({
  chatId: z.string().min(1),
  userId: z.string().min(1),
});

const updateProfileSchema = z.object({
  username: z.string().trim().min(2).max(32),
});

const addContactSchema = z.object({
  address: z.string().startsWith('0x'),
  username: z.string().trim().min(2).max(32).optional(),
});

const resolveSecretSchema = z.object({
  secretKey: z.string().trim().min(6),
});

function ok(res, data) {
  return res.json({ success: true, data });
}

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error('API route error:', error);
      return fail(res, 500, 'Internal server error');
    }
  };
}

export function createApiRouter() {
  const router = Router();

  router.get('/health', (_req, res) => ok(res, { status: 'ok' }));

  router.get('/auth/nonce/:address', asyncRoute(async (req, res) => {
    const nonce = await issueNonce(req.params.address);
    return ok(res, { nonce });
  }));

  router.post('/users/resolve-secret', asyncRoute(async (req, res) => {
    const parsed = resolveSecretSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Invalid payload');

    const user = await resolveUserBySecretKey(parsed.data.secretKey);
    if (!user) return fail(res, 404, 'No user found for this secret key');

    return ok(res, user);
  }));

  router.post('/auth/login', asyncRoute(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Invalid payload');

    const verifyResult = await verifyLoginSignature(parsed.data);
    if (verifyResult.error) return fail(res, 401, verifyResult.error);

    const user = await upsertUser(parsed.data.address);
    const token = signToken(user);
    return ok(res, { user, token });
  }));

  router.use(authMiddleware);

  router.get('/me', asyncRoute(async (req, res) => {
    const user = await getUserById(req.user.id);
    if (!user) return fail(res, 404, 'User not found');
    return ok(res, { ...user, address: req.user.address });
  }));

  router.patch('/me', asyncRoute(async (req, res) => {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Invalid payload');

    const result = await updateUsername(req.user.id, parsed.data.username);
    if (result.error) return fail(res, 400, result.error);

    const nextUser = { ...result.user, address: req.user.address };
    const token = signToken(nextUser);
    return ok(res, { user: nextUser, token });
  }));

  router.get('/contacts', asyncRoute(async (req, res) => {
    const contacts = await listContacts(req.user.id);
    return ok(res, contacts);
  }));

  router.post('/contacts', asyncRoute(async (req, res) => {
    const parsed = addContactSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Invalid payload');

    const result = await addContact(req.user.id, parsed.data.address, parsed.data.username);
    if (result.error) return fail(res, 400, result.error);

    return ok(res, result.contact);
  }));

  router.delete('/contacts/:contactId', asyncRoute(async (req, res) => {
    const result = await removeContact(req.user.id, req.params.contactId);
    if (result.error) return fail(res, 404, result.error);
    return ok(res, { removed: true });
  }));

  router.get('/users', asyncRoute(async (_req, res) => ok(res, await listUsers())));

  router.get('/users/search', asyncRoute(async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    return ok(res, await searchUsers(query));
  }));

  router.get('/chats', asyncRoute(async (req, res) => {
    const chats = await listChatsForUser(req.user.id);
    return ok(res, {
      items: chats,
      total: chats.length,
      hasMore: false,
    });
  }));

  router.get('/chats/:chatId', asyncRoute(async (req, res) => {
    const chat = await getChat(req.params.chatId);
    if (!chat) return fail(res, 404, 'Chat not found');
    if (!chat.participants.includes(req.user.id)) return fail(res, 403, 'Forbidden');
    return ok(res, chat);
  }));

  router.post('/chats', asyncRoute(async (req, res) => {
    const parsed = createChatSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Invalid payload');

    const participants = [...new Set([req.user.id, ...parsed.data.participants])];
    const chat = await createChat({ ...parsed.data, participants }, req.user.id);
    return ok(res, chat);
  }));

  router.patch('/chats/group', asyncRoute(async (req, res) => {
    const parsed = updateGroupSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Invalid payload');

    const result = await updateGroup(parsed.data, req.user.id);
    if (result.error) return fail(res, 400, result.error);
    return ok(res, result.chat);
  }));

  router.get('/messages/:chatId', asyncRoute(async (req, res) => {
    const chat = await getChat(req.params.chatId);
    if (!chat) return fail(res, 404, 'Chat not found');
    if (!chat.participants.includes(req.user.id)) return fail(res, 403, 'Forbidden');

    const items = await getMessages(req.params.chatId);
    return ok(res, {
      items,
      total: items.length,
      hasMore: false,
    });
  }));

  router.post('/messages', asyncRoute(async (req, res) => {
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Invalid payload');

    const result = await saveMessage(parsed.data, req.user.id);
    if (result.error) return fail(res, 400, result.error);

    const io = getSocketServer();
    if (io?.to) {
      const participantRooms = Array.isArray(result.participants)
        ? [...new Set(result.participants.map((participantId) => `user:${participantId}`))]
        : [];

      io.to(parsed.data.chatId).emit('message:new', result.message);
      for (const room of participantRooms) {
        io.to(room).emit('message:new', result.message);
      }
    }

    return ok(res, result.message);
  }));

  router.post('/groups/participants', asyncRoute(async (req, res) => {
    const parsed = addParticipantsSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Invalid payload');

    const result = await addParticipants(parsed.data.chatId, parsed.data.userIds, req.user.id);
    if (result.error) return fail(res, 400, result.error);
    return ok(res, result.chat);
  }));

  router.delete('/groups/participants', asyncRoute(async (req, res) => {
    const parsed = removeParticipantSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Invalid payload');

    const result = await removeParticipant(parsed.data.chatId, parsed.data.userId, req.user.id);
    if (result.error) return fail(res, 400, result.error);
    return ok(res, result.chat);
  }));

  return router;
}
