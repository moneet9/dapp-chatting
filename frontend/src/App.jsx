import { useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { io } from 'socket.io-client';
import { LogOut, Plus, Send, UserRound } from 'lucide-react';
import { CHAT_REGISTRY_ABI } from './chatRegistryAbi.js';
import {
  decryptTextForChat,
  encryptTextForChat,
  getOrCreateSelfSecretId,
  getStoredContactSecretId,
  storeContactSecretId,
} from './secureChat.js';
import './App.css';

const BACKEND_URL = 'http://localhost:3001';
const CHAT_REGISTRY_ADDRESS = import.meta.env.VITE_CHAT_REGISTRY_ADDRESS || '';

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

function getRegistry(providerOrSigner) {
  if (!CHAT_REGISTRY_ADDRESS) {
    throw new Error('Set VITE_CHAT_REGISTRY_ADDRESS in frontend/.env');
  }
  return new ethers.Contract(CHAT_REGISTRY_ADDRESS, CHAT_REGISTRY_ABI, providerOrSigner);
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

  const contactsForUi = useMemo(() => {
    return [...contacts].sort((a, b) => {
      const chatA = directChatByContactId.get(a.id);
      const chatB = directChatByContactId.get(b.id);
      const timeA = chatA?.lastMessageTime || 0;
      const timeB = chatB?.lastMessageTime || 0;
      if (timeA !== timeB) return timeB - timeA;
      return (a.username || '').localeCompare(b.username || '');
    });
  }, [contacts, directChatByContactId]);

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

    setIsConnecting(true);
    setError('');
    setNotice('');

    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send('eth_requestAccounts', []);
      const userAddress = accounts[0];
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
    } catch (connectionError) {
      console.error('Connection failed:', connectionError);
      setError(connectionError.message || 'Connection failed.');
    } finally {
      setIsConnecting(false);
    }
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

    (async () => {
      try {
        const [mePayload, contactsPayload, chatsPayload] = await Promise.all([
          apiRequest('/api/me', { token }),
          apiRequest('/api/contacts', { token }),
          apiRequest('/api/chats', { token }),
        ]);

        if (cancelled) return;

        const me = mePayload.data;
        const contactItems = Array.isArray(contactsPayload.data) ? contactsPayload.data : [];
        const chatItems = normalizeChats(chatsPayload.data?.items || []);

        setCurrentUser(me);
        setAddress(me?.address || null);
        setProfileUsername(me?.username || '');
        setContacts(contactItems);
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
    })();

    return () => {
      cancelled = true;
    };
  }, [token, activeContactId]);

  useEffect(() => {
    if (!token) return;

    const newSocket = io(BACKEND_URL, { auth: { token } });

    newSocket.on('connect_error', (socketError) => {
      setError(socketError.message || 'Socket connection failed.');
    });

    newSocket.on('message:new', (message) => {
      setChats((prev) => {
        const existingChat = prev.find((chat) => chat.id === message.chatId);
        if (!existingChat) return prev;

        const updatedChat = {
          ...existingChat,
          lastMessage: message,
          lastMessageTime: message.timestamp,
        };

        return [updatedChat, ...prev.filter((chat) => chat.id !== message.chatId)];
      });

      if (message.chatId === activeChatIdRef.current) {
        setRawMessages((prev) => [...prev, message]);
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

    const contactSecretId = getStoredContactSecretId(walletAddress, activeContactId);
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
  }, [rawMessages, activeContactId, profileSecretId, address, currentUser?.address]);

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
    const walletAddress = address || currentUser?.address;
    const secretId = profileSecretId || getOrCreateSelfSecretId(walletAddress);

    if (username.length < 2 || username.length > 32) {
      setError('Username must be 2 to 32 characters.');
      return;
    }

    if (!secretId) {
      setError('Unable to prepare your secret ID.');
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
      }

      if (CHAT_REGISTRY_ADDRESS) {
        if (!window.ethereum) {
          throw new Error('MetaMask is required to register secret ID on blockchain.');
        }

        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();
        const registry = getRegistry(signer);

        const tx = await registry.upsertProfile(username, secretId);
        await tx.wait();
      }

      setProfileSecretId(secretId);
      setIsProfileModalOpen(false);
      setNotice(
        CHAT_REGISTRY_ADDRESS
          ? 'Username saved. Keep your Secret ID safe because it unlocks private chats.'
          : 'Username saved locally. Set contract address later to publish your Secret ID on-chain.'
      );
    } catch (saveError) {
      setError(saveError.message || 'Failed to save profile.');
    } finally {
      setIsSavingProfile(false);
    }
  };

  const addContactBySecret = async (event) => {
    event.preventDefault();
    if (!token) return;

    const secretKey = contactSecretKey.trim();
    if (secretKey.length < 6) {
      setError('Secret ID must be at least 6 characters.');
      return;
    }

    if (!window.ethereum) {
      setError('MetaMask is required to search contact on blockchain.');
      return;
    }

    setIsAddingContact(true);
    setError('');
    setNotice('');

    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const registry = getRegistry(provider);

      const resolvedAddress = await registry.resolveContactKey(secretKey);
      if (!resolvedAddress || resolvedAddress === ethers.ZeroAddress) {
        throw new Error('No user found for this secret ID.');
      }

      const [chainUsername] = await registry.getProfile(resolvedAddress);

      const contactPayload = await apiRequest('/api/contacts', {
        token,
        method: 'POST',
        body: {
          address: resolvedAddress,
          username: chainUsername || undefined,
        },
      });

      const newContact = contactPayload.data;
      if (newContact) {
        const walletAddress = address || currentUser?.address;
        if (walletAddress) {
          storeContactSecretId(walletAddress, newContact.id, secretKey);
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
      setNotice('Contact added from blockchain secret ID.');
    } catch (addError) {
      setError(addError.message || 'Failed to add contact.');
    } finally {
      setIsAddingContact(false);
    }
  };

  const sendMessage = async (event) => {
    event.preventDefault();
    if (!msgInput.trim() || !activeChat?.id || !token) return;

    if (!profileSecretId || !activeContactSecretId) {
      setError('This chat is locked on this device. Add the contact Secret ID again to unlock it.');
      return;
    }

    const content = msgInput.trim();
    setMsgInput('');
    setError('');
    setNotice('');

    try {
      const encryptedContent = await encryptTextForChat(content, profileSecretId, activeContactSecretId);
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

  const activeContact = contacts.find((contact) => contact.id === activeContactId) || null;
  const walletAddress = address || currentUser?.address || '';

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
            <span className="summary-label">My Secret ID</span>
            <span className="summary-code">{profileSecretId || 'Generating...'}</span>
          </div>
        </div>

        <form className="panel" onSubmit={addContactBySecret}>
          <h4>Add Contact By Secret ID</h4>
          <div className="add-row">
            <input
              type="text"
              value={contactSecretKey}
              onChange={(event) => setContactSecretKey(event.target.value)}
              placeholder="Enter contact secret ID"
              minLength={6}
              maxLength={64}
            />
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
                  <span className="contact-time">{formatMessageTime(chat?.lastMessageTime)}</span>
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
                This chat is locked on this device. You must add this contact using their Secret ID here before messages can be decrypted.
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
                placeholder={isChatLocked ? 'Unlock this contact with Secret ID to chat' : 'Type a message...'}
                disabled={isChatLocked}
              />
              <button type="submit" disabled={!msgInput.trim() || isChatLocked} title="Send message">
                <Send size={18} />
              </button>
            </form>
          </>
        ) : (
          <div className="empty-state">Add a contact with secret ID and click it to load all previous chats.</div>
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
                <span className="summary-label">Secret ID</span>
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

