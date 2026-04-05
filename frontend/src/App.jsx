import { useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { io } from 'socket.io-client';
import { LogOut, Plus, Send, UserRound } from 'lucide-react';
import {
  decryptTextForChat,
  encryptTextForChat,
  getOrCreateSelfSecretId,
  getContactSecretStorageKey,
  hideContact,
  isHiddenContact,
  getStoredContactSecretId,
  storeContactSecretId,
  deriveSecretIdFromWalletAddress,
  deriveWalletAddressFromSecretId,
  resolveContactAddressFromInput,
  unhideContact,
} from './secureChat.js';
import './App.css';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

function decodeToken(token) {
  if (!token) return null;

  try {
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return null;

    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = JSON.parse(window.atob(padded));

    return {
      id: decoded.sub,
      address: decoded.address,
      username: decoded.username,
    };
  } catch {
    return null;
  }
}

function shortenAddress(value) {
  if (!value || typeof value !== 'string') return 'Unknown';
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatMessageTime(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getDirectParticipantsKey(participants) {
  const normalized = [...new Set(Array.isArray(participants) ? participants : [])].sort();
  if (normalized.length !== 2) return null;
  return normalized.join(':');
}

function normalizeChats(chatItems) {
  const seenDirect = new Set();
  const normalized = [];

  for (const chat of chatItems) {
    if (chat.type === 'direct') {
      const key = getDirectParticipantsKey(chat.participants);
      if (key) {
        if (seenDirect.has(key)) continue;
        seenDirect.add(key);
      }
    }
    normalized.push(chat);
  }

  return normalized;
}

function mergeContactsWithChats(contactItems, chatItems, userItems, currentUserId, walletAddress) {
  const contactsById = new Map();

  for (const contact of Array.isArray(contactItems) ? contactItems : []) {
    if (contact?.id) {
      contactsById.set(contact.id, contact);
    }
  }

  const usersById = new Map((Array.isArray(userItems) ? userItems : []).map((user) => [user.id, user]));

  for (const chat of Array.isArray(chatItems) ? chatItems : []) {
    if (chat.type !== 'direct' || !Array.isArray(chat.participants) || !currentUserId) continue;

    const peerId = chat.participants.find((participantId) => participantId !== currentUserId);
    if (!peerId || contactsById.has(peerId) || isHiddenContact(walletAddress, peerId)) continue;

    const peerUser = usersById.get(peerId);
    if (!peerUser) continue;

    contactsById.set(peerId, peerUser);
  }

  return Array.from(contactsById.values());
}

function upsertContactFromMessage(message, walletAddress, currentUserId) {
  if (!walletAddress || !currentUserId || !message?.senderId || message.senderId === currentUserId) {
    return null;
  }

  if (isHiddenContact(walletAddress, message.senderId)) {
    return null;
  }

  return {
    id: message.senderId,
    username: message.senderUsername || fallbackName(message.senderId, 'Contact'),
    address: message.senderAddress || '',
    secretKey: deriveSecretIdFromWalletAddress(message.senderAddress),
  };
}

async function apiRequest(path, { token, method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }

  return payload;
}

function fallbackName(value, prefix = 'User') {
  const normalized = String(value || '').trim();
  if (!normalized) return `${prefix}-unknown`;
  return `${prefix}-${normalized.slice(-6)}`;
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [currentUser, setCurrentUser] = useState(() => decodeToken(localStorage.getItem('token')));
  const [address, setAddress] = useState(() => decodeToken(localStorage.getItem('token'))?.address || null);
  const [socket, setSocket] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [chats, setChats] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [activeContactId, setActiveContactId] = useState(null);
  const [rawMessages, setRawMessages] = useState([]);
  const [messages, setMessages] = useState([]);
  const [msgInput, setMsgInput] = useState('');
  const [profileUsername, setProfileUsername] = useState('');
  const [profileSecretId, setProfileSecretId] = useState('');
  const [contactSecretKey, setContactSecretKey] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isAddingContact, setIsAddingContact] = useState(false);
  const [isChatLocked, setIsChatLocked] = useState(false);
  const [activeContactSecretId, setActiveContactSecretId] = useState('');
  const [openingContactId, setOpeningContactId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const activeChatIdRef = useRef(null);
  const walletConnectRef = useRef(null);

  useEffect(() => {
    activeChatIdRef.current = activeChat?.id || null;
  }, [activeChat]);

  const directChatByContactId = useMemo(() => {
    const map = new Map();

    for (const chat of chats) {
      if (chat.type !== 'direct' || !Array.isArray(chat.participants) || !currentUser?.id) continue;
      const peerId = chat.participants.find((participantId) => participantId !== currentUser.id);
      if (!peerId) continue;

      const existing = map.get(peerId);
      if (!existing || (chat.lastMessageTime || 0) > (existing.lastMessageTime || 0)) {
        map.set(peerId, chat);
      }
    }

    return map;
  }, [chats, currentUser?.id]);

  const walletAddress = address || currentUser?.address;

  const visibleContacts = useMemo(() => {
    return contacts.filter((contact) => !isHiddenContact(walletAddress, contact.id));
  }, [contacts, walletAddress]);

  const contactsForUi = useMemo(() => {
    return [...visibleContacts].sort((a, b) => {
      const chatA = directChatByContactId.get(a.id);
      const chatB = directChatByContactId.get(b.id);
      const timeA = chatA?.lastMessageTime || 0;
      const timeB = chatB?.lastMessageTime || 0;
      if (timeA !== timeB) return timeB - timeA;
      return (a.username || '').localeCompare(b.username || '');
    });
  }, [visibleContacts, directChatByContactId]);

  const activeContact = visibleContacts.find((contact) => contact.id === activeContactId) || null;

  useEffect(() => {
    if (!token) return;
    const decoded = decodeToken(token);
    if (!decoded) return;
    setCurrentUser((prev) => prev || decoded);
    setAddress((prev) => prev || decoded.address || null);
  }, [token]);

  useEffect(() => {
    if (!token) return;

    const walletAddress = address || currentUser?.address;
    if (!walletAddress) return;

    setProfileSecretId(getOrCreateSelfSecretId(walletAddress));
  }, [token, address, currentUser?.address]);

  const connectWallet = async () => {
    if (!window.ethereum) {
      setError('Please install MetaMask to continue.');
      return;
    }

    if (walletConnectRef.current) {
      return walletConnectRef.current;
    }

    setIsConnecting(true);
    setError('');
    setNotice('');

    walletConnectRef.current = (async () => {
      try {
        const provider = new ethers.BrowserProvider(window.ethereum);
        const existingAccounts = await provider.send('eth_accounts', []);
        const accounts =
          Array.isArray(existingAccounts) && existingAccounts.length > 0
            ? existingAccounts
            : await provider.send('eth_requestAccounts', []);

        const userAddress = accounts[0];
        if (!userAddress) {
          throw new Error('No wallet account was returned.');
        }

        setAddress(userAddress);

        const noncePayload = await apiRequest(`/api/auth/nonce/${userAddress}`);
        const nonce = noncePayload.data?.nonce;
        if (!nonce) throw new Error('Unable to issue login nonce.');

        const message = `Please sign this message to verify your identity. Nonce: ${nonce}`;
        const signer = await provider.getSigner();
        const signature = await signer.signMessage(message);

        const loginPayload = await apiRequest('/api/auth/login', {
          method: 'POST',
          body: { address: userAddress, signature, message },
        });

        const nextToken = loginPayload.data?.token;
        if (!nextToken) throw new Error('Login failed: token missing.');

        localStorage.setItem('token', nextToken);
        setToken(nextToken);
        setCurrentUser(loginPayload.data?.user || decodeToken(nextToken));
        setAddress(loginPayload.data?.user?.address || userAddress);
        setProfileSecretId(getOrCreateSelfSecretId(userAddress));
      } catch (connectionError) {
        console.error('Connection failed:', connectionError);

        if (connectionError?.code === -32002) {
          setError('A wallet approval request is already pending. Open your wallet and complete it, then try again if needed.');
          return;
        }

        setError(connectionError.message || 'Connection failed.');
      } finally {
        setIsConnecting(false);
        walletConnectRef.current = null;
      }
    })();

    return walletConnectRef.current;
  };

  const logout = () => {
    setError('');
    setNotice('');
    setToken(null);
    setCurrentUser(null);
    setAddress(null);
    setContacts([]);
    setChats([]);
    setActiveChat(null);
    setActiveContactId(null);
    setRawMessages([]);
    setMessages([]);
    setMsgInput('');
    setProfileUsername('');
    setProfileSecretId('');
    setIsProfileModalOpen(false);
    setContactSecretKey('');
    setIsChatLocked(false);
    setActiveContactSecretId('');
    localStorage.removeItem('token');
    if (socket) socket.disconnect();
    setSocket(null);
  };

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const refreshChatData = async () => {
      try {
        const [mePayload, contactsPayload, chatsPayload, usersPayload] = await Promise.all([
          apiRequest('/api/me', { token }),
          apiRequest('/api/contacts', { token }),
          apiRequest('/api/chats', { token }),
          apiRequest('/api/users', { token }),
        ]);

        if (cancelled) return;

        const me = mePayload.data;
        const contactItems = Array.isArray(contactsPayload.data) ? contactsPayload.data : [];
        const chatItems = normalizeChats(chatsPayload.data?.items || []);
        const userItems = Array.isArray(usersPayload.data) ? usersPayload.data : [];
        const nextWalletAddress = me?.address || address || currentUser?.address;

        setCurrentUser(me);
        setAddress(me?.address || null);
        setProfileUsername(me?.username || '');
        setContacts(mergeContactsWithChats(contactItems, chatItems, userItems, me?.id, nextWalletAddress));
        setChats(chatItems);

        if (activeContactId) {
          const targetChat = chatItems.find((chat) => {
            if (chat.type !== 'direct') return false;
            return chat.participants?.includes(activeContactId);
          });
          setActiveChat(targetChat || null);
        }
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError.message || 'Failed to load chat data.');
        }
      }
    };

    refreshChatData();
    const refreshTimer = window.setInterval(refreshChatData, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, [token, activeContactId]);

  useEffect(() => {
    const walletAddress = address || currentUser?.address;
    if (!walletAddress || !Array.isArray(contacts) || contacts.length === 0) return;

    for (const contact of contacts) {
      if (contact?.id && contact?.address) {
        storeContactSecretId(walletAddress, contact.id, getOrCreateSelfSecretId(contact.address));
      }
    }
  }, [contacts, address, currentUser?.address]);

  useEffect(() => {
    const walletAddress = address || currentUser?.address;
    if (!walletAddress || !currentUser?.id || !Array.isArray(rawMessages) || rawMessages.length === 0) return;

    for (const message of rawMessages) {
      const contact = upsertContactFromMessage(message, walletAddress, currentUser.id);
      if (!contact) {
        continue;
      }

      if (contact?.secretKey) {
        storeContactSecretId(walletAddress, contact.id, contact.secretKey);
      }
      setContacts((prev) => {
        const existingIndex = prev.findIndex((item) => item.id === contact.id);
        if (existingIndex === -1) {
          return [...prev, contact];
        }

        const nextContacts = [...prev];
        nextContacts[existingIndex] = {
          ...nextContacts[existingIndex],
          ...contact,
        };
        return nextContacts;
      });

      setChats((prev) => {
        const existingChat = prev.find((chat) => chat.id === message.chatId);
        if (existingChat) {
          return prev;
        }

        const placeholderChat = {
          id: message.chatId,
          type: 'direct',
          participants: [currentUser.id, message.senderId],
          lastMessage: message,
          lastMessageTime: message.timestamp,
          unreadCount: 0,
          createdAt: message.timestamp,
        };

        return [placeholderChat, ...prev];
      });
    }
  }, [rawMessages, address, currentUser?.address, currentUser?.id]);

  useEffect(() => {
    if (!token) return;

    const newSocket = io(BACKEND_URL, {
      auth: { token },
      transports: ['websocket'],
    });

    newSocket.on('connect_error', (socketError) => {
      setError(socketError.message || 'Socket connection failed.');
    });

    newSocket.on('message:new', (message) => {
      const walletAddress = address || currentUser?.address;
      const incomingContact = upsertContactFromMessage(message, walletAddress, currentUser?.id);
      const shouldAutoOpenChat = !activeChatIdRef.current && message.senderId && currentUser?.id && message.senderId !== currentUser.id;

      if (incomingContact?.secretKey && walletAddress) {
        storeContactSecretId(walletAddress, incomingContact.id, incomingContact.secretKey);
        setContacts((prev) => {
          const existingIndex = prev.findIndex((item) => item.id === incomingContact.id);
          if (existingIndex === -1) {
            return [...prev, incomingContact];
          }

          const nextContacts = [...prev];
          nextContacts[existingIndex] = {
            ...nextContacts[existingIndex],
            ...incomingContact,
          };
          return nextContacts;
        });
      }

      if (shouldAutoOpenChat) {
        setActiveContactId(message.senderId);
        setActiveChat((prev) => {
          if (prev?.id === message.chatId) return prev;

          return {
            id: message.chatId,
            type: 'direct',
            participants: [currentUser.id, message.senderId],
            lastMessage: message,
            lastMessageTime: message.timestamp,
            unreadCount: 0,
            createdAt: message.timestamp,
          };
        });
      }

      setChats((prev) => {
        const existingChat = prev.find((chat) => chat.id === message.chatId);
        if (!existingChat) {
          if (message.senderId && currentUser?.id && message.senderId !== currentUser.id) {
            return [
              {
                id: message.chatId,
                type: 'direct',
                participants: [currentUser.id, message.senderId],
                lastMessage: message,
                lastMessageTime: message.timestamp,
                unreadCount: 0,
                createdAt: message.timestamp,
              },
              ...prev,
            ];
          }

          return prev;
        }

        const updatedChat = {
          ...existingChat,
          lastMessage: message,
          lastMessageTime: message.timestamp,
        };

        return [updatedChat, ...prev.filter((chat) => chat.id !== message.chatId)];
      });

      if (message.chatId === activeChatIdRef.current) {
        setRawMessages((prev) => (prev.some((item) => item.id === message.id) ? prev : [...prev, message]));
      }
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, [token]);

  useEffect(() => {
    if (!activeChat?.id || !token || !socket) return;

    const selectedChatId = activeChat.id;
    let cancelled = false;

    socket.emit('chat:join', selectedChatId);
    setRawMessages([]);

    (async () => {
      try {
        const payload = await apiRequest(`/api/messages/${selectedChatId}`, { token });
        if (!cancelled) {
          setRawMessages(payload.data?.items || []);
        }
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError.message || 'Failed to load messages.');
        }
      }
    })();

    return () => {
      cancelled = true;
      socket.emit('chat:leave', selectedChatId);
    };
  }, [activeChat?.id, token, socket]);

  useEffect(() => {
    const walletAddress = address || currentUser?.address;
    if (!activeContactId || !walletAddress) {
      setActiveContactSecretId('');
      setIsChatLocked(false);
      setMessages([]);
      return;
    }

    const contactSecretId =
      getStoredContactSecretId(walletAddress, activeContactId) ||
      deriveSecretIdFromWalletAddress(activeContact?.address);
    setActiveContactSecretId(contactSecretId);

    if (!profileSecretId || !contactSecretId) {
      setIsChatLocked(true);
      setMessages(
        rawMessages.map((message) => ({
          ...message,
          displayContent: 'Locked message. Add this contact on this device to read it.',
        }))
      );
      return;
    }

    let cancelled = false;

    (async () => {
      const decryptedMessages = await Promise.all(
        rawMessages.map(async (message) => ({
          ...message,
          displayContent: await decryptTextForChat(
            message.encryptedContent,
            profileSecretId,
            contactSecretId
          ),
        }))
      );

      if (!cancelled) {
        setIsChatLocked(false);
        setMessages(decryptedMessages);
      }
    })().catch(() => {
      if (!cancelled) {
        setIsChatLocked(true);
        setMessages(
          rawMessages.map((message) => ({
            ...message,
            displayContent: 'Unable to decrypt message on this device.',
          }))
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [rawMessages, activeContactId, profileSecretId, address, currentUser?.address, activeContact?.address]);

  const openDirectChat = async (contactId) => {
    if (!token || !currentUser?.id || contactId === currentUser.id) return;
    if (openingContactId) return;

    setError('');
    setNotice('');
    setActiveContactId(contactId);

    const existingChat = directChatByContactId.get(contactId);
    if (existingChat) {
      setActiveChat(existingChat);
      return;
    }

    setOpeningContactId(contactId);
    try {
      const payload = await apiRequest('/api/chats', {
        token,
        method: 'POST',
        body: { type: 'direct', participants: [contactId] },
      });

      const chat = payload.data;
      if (!chat) return;

      setChats((prev) => [chat, ...prev.filter((item) => item.id !== chat.id)]);
      setActiveChat(chat);
    } catch (chatError) {
      setError(chatError.message || 'Failed to open chat.');
    } finally {
      setOpeningContactId(null);
    }
  };

  const saveProfile = async (event) => {
    event.preventDefault();
    if (!token) return;

    const username = profileUsername.trim();
    if (username.length < 2 || username.length > 32) {
      setError('Username must be 2 to 32 characters.');
      return;
    }

    setIsSavingProfile(true);
    setError('');
    setNotice('');

    try {
      const profilePayload = await apiRequest('/api/me', {
        token,
        method: 'PATCH',
        body: { username },
      });

      const nextUser = profilePayload.data?.user;
      const nextToken = profilePayload.data?.token;

      if (nextToken) {
        localStorage.setItem('token', nextToken);
        setToken(nextToken);
      }
      if (nextUser) {
        setCurrentUser(nextUser);
        setProfileUsername(nextUser.username || username);
        setProfileSecretId(getOrCreateSelfSecretId(nextUser.address || address || currentUser?.address));
      }
      setIsProfileModalOpen(false);
      setNotice('Username saved. Your secret key is derived from your wallet address.');
    } catch (saveError) {
      setError(saveError.message || 'Failed to save profile.');
    } finally {
      setIsSavingProfile(false);
    }
  };

  const addContactBySecret = async (event) => {
    event.preventDefault();

    await submitContactSecret(contactSecretKey);
  };

  const submitContactSecret = async (secretValue) => {
    if (!token) return;

    const secretKey = String(secretValue || '').trim();
    if (secretKey.length < 6) {
      setError('Secret ID must be at least 6 characters.');
      return;
    }

    setIsAddingContact(true);
    setError('');
    setNotice('');

    try {
      let resolvedUser = null;
      let resolvedAddress = resolveContactAddressFromInput(secretKey);
      if (!resolvedAddress) {
        try {
          const resolvedPayload = await apiRequest('/api/users/resolve-secret', {
            token,
            method: 'POST',
            body: { secretKey },
          });
          resolvedAddress = resolvedPayload.data?.address || '';
          resolvedUser = resolvedPayload.data || null;
        } catch {
          resolvedAddress = '';
        }
      }

      if (!resolvedAddress) {
        throw new Error('Enter a wallet address or an sk- secret key.');
      }

      const contactSecretId = deriveSecretIdFromWalletAddress(resolvedAddress);

      const contactPayload = await apiRequest('/api/contacts', {
        token,
        method: 'POST',
        body: {
          address: resolvedAddress,
          username: resolvedUser?.username || undefined,
        },
      });

      const newContact = contactPayload.data;
      if (newContact) {
        const walletAddress = address || currentUser?.address;
        if (walletAddress) {
          unhideContact(walletAddress, newContact.id);
          storeContactSecretId(walletAddress, newContact.id, contactSecretId);
          if (activeContactId === newContact.id) {
            setRawMessages((prev) => [...prev]);
          }
        }

        setContacts((prev) => {
          const filtered = prev.filter((item) => item.id !== newContact.id);
          return [...filtered, newContact];
        });
      }

      setContactSecretKey('');
      setNotice('Contact added from secret key.');
    } catch (addError) {
      setError(addError.message || 'Failed to add contact.');
    } finally {
      setIsAddingContact(false);
    }
  };

  const deleteContact = async (contactId) => {
    if (!token || !contactId) return;

    const confirmed = window.confirm('Delete this contact from your list?');
    if (!confirmed) return;

    setError('');
    setNotice('');

    const walletAddress = address || currentUser?.address;
    const removeFromUi = () => {
      if (walletAddress) {
        hideContact(walletAddress, contactId);
        window.localStorage.removeItem(getContactSecretStorageKey(walletAddress, contactId));
      }

      setContacts((prev) => prev.filter((item) => item.id !== contactId));

      if (activeContactId === contactId) {
        setActiveContactId(null);
        setActiveChat(null);
        setRawMessages([]);
        setMessages([]);
        setActiveContactSecretId('');
        setIsChatLocked(false);
      }
    };

    try {
      await apiRequest(`/api/contacts/${contactId}`, {
        token,
        method: 'DELETE',
      });
      removeFromUi();
      setNotice('Contact removed from your list.');
    } catch (deleteError) {
      if (deleteError?.message?.includes('Contact not found')) {
        removeFromUi();
        setNotice('Contact removed from your list.');
        return;
      }

      setError(deleteError.message || 'Failed to delete contact.');
    }
  };

  const pasteContactSecret = async () => {
    if (!window?.navigator?.clipboard?.readText) {
      setError('Clipboard paste is not available in this browser.');
      return;
    }

    try {
      const pastedValue = await window.navigator.clipboard.readText();
      const secretKey = String(pastedValue || '').trim();
      if (!secretKey) {
        setError('Clipboard is empty.');
        return;
      }

      setContactSecretKey(secretKey);

      const walletAddress = address || currentUser?.address;
      if (activeContactId && walletAddress) {
        storeContactSecretId(walletAddress, activeContactId, secretKey);
        setActiveContactSecretId(secretKey);
        setIsChatLocked(false);

        try {
          const decryptedMessages = await Promise.all(
            rawMessages.map(async (message) => ({
              ...message,
              displayContent: await decryptTextForChat(message.encryptedContent, profileSecretId, secretKey),
            }))
          );

          setMessages(decryptedMessages);
          setNotice('Chat unlocked with pasted secret key.');
          setError('');
          return;
        } catch {
          setIsChatLocked(true);
        }
      }

      await submitContactSecret(secretKey);
    } catch (pasteError) {
      setError(pasteError.message || 'Failed to paste secret key.');
    }
  };

  const sendMessage = async (event) => {
    event.preventDefault();
    if (!msgInput.trim() || !activeChat?.id || !token) return;

    const walletAddress = address || currentUser?.address;
    const contactSecretId =
      activeContactSecretId ||
      (walletAddress ? getStoredContactSecretId(walletAddress, activeContactId) : '') ||
      deriveSecretIdFromWalletAddress(activeContact?.address);

    if (!profileSecretId || !contactSecretId) {
      setError('This chat is locked on this device. Add the contact Secret Key again to unlock it.');
      return;
    }

    const content = msgInput.trim();
    setMsgInput('');
    setError('');
    setNotice('');

    try {
      const encryptedContent = await encryptTextForChat(content, profileSecretId, contactSecretId);
      const payload = await apiRequest('/api/messages', {
        token,
        method: 'POST',
        body: {
          chatId: activeChat.id,
          type: 'text',
          encryptedContent,
        },
      });

      const savedMessage = payload.data;
      if (savedMessage) {
        setRawMessages((prev) => [...prev, savedMessage]);
        setChats((prev) => {
          const existingChat = prev.find((chat) => chat.id === activeChat.id);
          if (!existingChat) return prev;

          const updatedChat = {
            ...existingChat,
            lastMessage: savedMessage,
            lastMessageTime: savedMessage.timestamp,
          };

          return [updatedChat, ...prev.filter((chat) => chat.id !== activeChat.id)];
        });
      }
    } catch (sendError) {
      setMsgInput(content);
      setError(sendError.message || 'Failed to send message.');
    }
  };

  if (!token) {
    return (
      <div className="login-container">
        <h1>Web3 dApp Chat</h1>
        <button className="connect-btn" onClick={connectWallet} disabled={isConnecting}>
          {isConnecting ? 'Connecting...' : 'Connect Wallet & Login'}
        </button>
        {error ? <p className="error-banner">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div className="header">
          <div>
            <h3>{currentUser?.username || 'My Chat'}</h3>
            <p className="wallet-line">{shortenAddress(address || currentUser?.address)}</p>
          </div>
          <button onClick={logout} className="icon-btn" title="Logout">
            <LogOut size={18} />
          </button>
        </div>

        <div className="panel profile-summary">
          <div className="profile-summary-head">
            <div>
              <h4>My Profile</h4>
              <div className="summary-value">{currentUser?.username || 'No username yet'}</div>
            </div>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => {
                setProfileUsername(currentUser?.username || profileUsername);
                setIsProfileModalOpen(true);
              }}
            >
              Change
            </button>
          </div>
          <div className="summary-row">
            <span className="summary-label">My Secret Key</span>
            <span className="summary-code">{profileSecretId || 'Generating...'}</span>
          </div>
        </div>

        <form className="panel" onSubmit={addContactBySecret}>
          <h4>Add Contact By Secret Key or Wallet Address</h4>
          <div className="add-row">
            <input
              type="text"
              value={contactSecretKey}
              onChange={(event) => setContactSecretKey(event.target.value)}
              placeholder="Enter contact secret key or wallet address"
              minLength={6}
              maxLength={64}
            />
            <button type="button" className="secondary-btn" onClick={pasteContactSecret} title="Paste secret key">
              Paste
            </button>
            <button type="submit" disabled={isAddingContact} title="Add contact">
              {isAddingContact ? '...' : <Plus size={16} />}
            </button>
          </div>
        </form>

        <div className="contacts-list">
          <h4>Contacts</h4>
          {contactsForUi.length === 0 ? <p className="hint-text">No contacts yet.</p> : null}
          {contactsForUi.map((contact) => {
            const chat = directChatByContactId.get(contact.id);
            const isActive = activeContactId === contact.id;
            const hasContactSecret = Boolean(getStoredContactSecretId(walletAddress, contact.id));

            return (
              <button
                key={contact.id}
                type="button"
                className={`contact-item ${isActive ? 'active' : ''}`}
                onClick={() => openDirectChat(contact.id)}
                disabled={openingContactId === contact.id}
              >
                <div className="contact-head">
                  <span className="contact-name">{contact.username || fallbackName(contact.id, 'Contact')}</span>
                  <div className="contact-actions">
                    <span className="contact-time">{formatMessageTime(chat?.lastMessageTime)}</span>
                    <button
                      type="button"
                      className="contact-delete-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteContact(contact.id);
                      }}
                      aria-label={`Delete ${contact.username || fallbackName(contact.id, 'Contact')}`}
                      title="Delete contact"
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div className="contact-preview">
                  {chat?.lastMessage
                    ? hasContactSecret
                      ? 'Protected conversation'
                      : 'Locked on this device'
                    : 'No messages yet'}
                </div>
              </button>
            );
          })}
        </div>

        {notice ? <p className="notice-banner">{notice}</p> : null}
        {error ? <p className="error-banner in-sidebar">{error}</p> : null}
      </aside>

      <main className="chat-area">
        {activeContact ? (
          <>
            <div className="chat-header">
              <UserRound size={18} />
              <h3>{activeContact.username || fallbackName(activeContact.id, 'Contact')}</h3>
            </div>
            {isChatLocked ? (
              <div className="locked-banner">
                <div className="locked-banner-text">
                  This chat is locked on this device. You must add this contact using their Secret Key here before messages can be decrypted.
                </div>
                <div className="locked-banner-actions">
                  <button type="button" className="secondary-btn lock-action" onClick={pasteContactSecret}>
                    Paste Secret Key
                  </button>
                </div>
              </div>
            ) : null}
            <div className="messages">
              {messages.length === 0 ? <div className="empty-messages">No messages yet. Start your conversation.</div> : null}
              {messages.map((message) => (
                <div key={message.id} className={`message ${message.senderId === currentUser?.id ? 'sent' : 'received'}`}>
                  <div className="message-content">{message.displayContent || 'Locked message'}</div>
                  <div className="message-time">{formatMessageTime(message.timestamp)}</div>
                </div>
              ))}
            </div>
            <form onSubmit={sendMessage} className="input-area">
              <input
                type="text"
                value={msgInput}
                onChange={(event) => setMsgInput(event.target.value)}
                placeholder={isChatLocked ? 'Unlock this contact with Secret Key to chat' : 'Type a message...'}
                disabled={isChatLocked}
              />
              <button type="submit" disabled={!msgInput.trim() || isChatLocked} title="Send message">
                <Send size={18} />
              </button>
            </form>
          </>
        ) : (
          <div className="empty-state">Add a contact with secret key and click it to load all previous chats.</div>
        )}
      </main>

      {isProfileModalOpen ? (
        <div className="modal-overlay" onClick={() => !isSavingProfile && setIsProfileModalOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <h4>Change Username</h4>
            <form className="modal-form" onSubmit={saveProfile}>
              <input
                type="text"
                value={profileUsername}
                onChange={(event) => setProfileUsername(event.target.value)}
                placeholder="My username"
                minLength={2}
                maxLength={32}
                autoFocus
              />
              <div className="summary-row">
                <span className="summary-label">Secret Key</span>
                <span className="summary-code">{profileSecretId || 'Generating...'}</span>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setIsProfileModalOpen(false)}
                  disabled={isSavingProfile}
                >
                  Cancel
                </button>
                <button type="submit" disabled={isSavingProfile}>
                  {isSavingProfile ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;

