import { Server } from 'socket.io';
import { verifySocketToken } from './auth.js';
import { getChat, saveMessage, setUserStatus } from './store.js';

function withSocketError(socket, handler) {
  return (...args) => {
    Promise.resolve(handler(...args)).catch((error) => {
      console.error('Socket handler error:', error);
      socket.emit('error', 'Internal server error');
    });
  };
}

export function createSocketServer(httpServer, corsOrigin) {
  const io = new Server(httpServer, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Missing token'));
    }
    const user = verifySocketToken(token);
    if (!user) {
      return next(new Error('Invalid token'));
    }
    socket.data.user = user;
    return next();
  });

  io.on('connection', (socket) => {
    const currentUser = socket.data.user;
    setUserStatus(currentUser.id, 'online').catch((error) => {
      console.error('Failed to set user online status:', error);
    });
    io.emit('user:status', { userId: currentUser.id, status: 'online' });

    socket.on('chat:join', withSocketError(socket, async (chatId) => {
      const chat = await getChat(chatId);
      if (!chat || !chat.participants.includes(currentUser.id)) return;
      socket.join(chatId);
    }));

    socket.on('chat:leave', (chatId) => {
      socket.leave(chatId);
    });

    socket.on('typing:start', (chatId) => {
      socket.to(chatId).emit('typing:update', {
        chatId,
        userId: currentUser.id,
        username: currentUser.username,
        timestamp: Date.now(),
      });
    });

    socket.on('typing:stop', (chatId) => {
      socket.to(chatId).emit('typing:update', {
        chatId,
        userId: currentUser.id,
        username: currentUser.username,
        timestamp: 0,
      });
    });

    socket.on('message:send', withSocketError(socket, async (payload) => {
      const result = await saveMessage(payload, currentUser.id);
      if (result.error) {
        socket.emit('error', result.error);
        return;
      }

      socket.emit('message:status', {
        messageId: payload.tempId || result.message.id,
        status: 'sent',
      });

      io.to(payload.chatId).emit('message:new', result.message);

      socket.emit('message:status', {
        messageId: payload.tempId || result.message.id,
        status: 'delivered',
      });
    }));

    socket.on('message:read', ({ chatId, messageIds }) => {
      if (!Array.isArray(messageIds) || messageIds.length === 0) return;
      socket.to(chatId).emit('message:status', {
        messageId: messageIds[messageIds.length - 1],
        status: 'delivered',
      });
    });

    socket.on('disconnect', () => {
      setUserStatus(currentUser.id, 'offline').catch((error) => {
        console.error('Failed to set user offline status:', error);
      });
      io.emit('user:status', { userId: currentUser.id, status: 'offline' });
    });
  });

  return io;
}
