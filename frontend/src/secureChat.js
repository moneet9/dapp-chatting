const APP_SCOPE = 'dapp-chat-demo:v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizeWalletAddress(address) {
  return String(address || '').trim().toLowerCase();
}

function normalizeSecretId(secretId) {
  return String(secretId || '').trim();
}

export function deriveSecretIdFromWalletAddress(walletAddress) {
  const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
  if (!normalizedWalletAddress) return '';

  return `sk-${normalizedWalletAddress.replace(/^0x/, '')}`;
}

export function deriveWalletAddressFromSecretId(secretId) {
  const normalizedSecretId = normalizeSecretId(secretId);
  if (normalizedSecretId.toLowerCase().startsWith('0x')) {
    return normalizedSecretId.toLowerCase();
  }

  if (!normalizedSecretId.startsWith('sk-')) return '';

  const walletSuffix = normalizedSecretId.slice(3).trim();
  if (!walletSuffix) return '';

  return `0x${walletSuffix.replace(/^0x/, '')}`;
}

export function resolveContactAddressFromInput(inputValue) {
  const normalizedInput = normalizeSecretId(inputValue);
  if (!normalizedInput) return '';

  if (normalizedInput.toLowerCase().startsWith('0x')) {
    return normalizedInput.toLowerCase();
  }

  return deriveWalletAddressFromSecretId(normalizedInput);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return window.btoa(binary);
}

function base64ToBytes(base64) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function deriveChatKey(secretIdA, secretIdB) {
  const left = normalizeSecretId(secretIdA);
  const right = normalizeSecretId(secretIdB);
  if (!left || !right) {
    throw new Error('Both secret IDs are required to unlock this chat.');
  }

  const material = [left, right].sort().join(':');
  const hash = await window.crypto.subtle.digest('SHA-256', encoder.encode(`${APP_SCOPE}:${material}`));
  return window.crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function getSelfSecretStorageKey(walletAddress) {
  return `${APP_SCOPE}:self:${normalizeWalletAddress(walletAddress)}`;
}

export function getContactSecretStorageKey(walletAddress, contactId) {
  return `${APP_SCOPE}:contact:${normalizeWalletAddress(walletAddress)}:${String(contactId || '').trim()}`;
}

export function getHiddenContactStorageKey(walletAddress, contactId) {
  return `${APP_SCOPE}:hidden-contact:${normalizeWalletAddress(walletAddress)}:${String(contactId || '').trim()}`;
}

export function getOrCreateSelfSecretId(walletAddress) {
  return deriveSecretIdFromWalletAddress(walletAddress);
}

export function getStoredContactSecretId(walletAddress, contactId) {
  if (!walletAddress || !contactId || typeof window === 'undefined') return '';
  return window.localStorage.getItem(getContactSecretStorageKey(walletAddress, contactId)) || '';
}

export function storeContactSecretId(walletAddress, contactId, secretId) {
  if (!walletAddress || !contactId || typeof window === 'undefined') return;
  const normalizedSecretId = normalizeSecretId(secretId);
  if (!normalizedSecretId) return;
  window.localStorage.setItem(getContactSecretStorageKey(walletAddress, contactId), normalizedSecretId);
}

export function isHiddenContact(walletAddress, contactId) {
  if (!walletAddress || !contactId || typeof window === 'undefined') return false;
  return window.localStorage.getItem(getHiddenContactStorageKey(walletAddress, contactId)) === '1';
}

export function hideContact(walletAddress, contactId) {
  if (!walletAddress || !contactId || typeof window === 'undefined') return;
  window.localStorage.setItem(getHiddenContactStorageKey(walletAddress, contactId), '1');
}

export function unhideContact(walletAddress, contactId) {
  if (!walletAddress || !contactId || typeof window === 'undefined') return;
  window.localStorage.removeItem(getHiddenContactStorageKey(walletAddress, contactId));
}

export async function encryptTextForChat(plainText, selfSecretId, contactSecretId) {
  const key = await deriveChatKey(selfSecretId, contactSecretId);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(String(plainText || ''))
  );

  return JSON.stringify({
    v: 1,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted)),
  });
}

export async function decryptTextForChat(payload, selfSecretId, contactSecretId) {
  if (!payload) return '';

  try {
    const parsed = JSON.parse(payload);
    if (parsed?.v !== 1 || !parsed.iv || !parsed.data) {
      return String(payload);
    }

    const key = await deriveChatKey(selfSecretId, contactSecretId);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(parsed.iv) },
      key,
      base64ToBytes(parsed.data)
    );

    return decoder.decode(decrypted);
  } catch {
    return String(payload);
  }
}
