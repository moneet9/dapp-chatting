import { createHmac } from 'crypto';
import { config } from './config.js';

export function normalizeWalletAddress(address) {
  return String(address || '').trim().toLowerCase();
}

function hmacHex(scope, value) {
  return createHmac('sha256', config.privacySecret)
    .update(`${scope}:${value}`)
    .digest('hex');
}

export function getOpaqueUserId(address) {
  const wallet = normalizeWalletAddress(address);
  return `usr_${hmacHex('user', wallet)}`;
}

export function getOpaqueNonceId(address) {
  const wallet = normalizeWalletAddress(address);
  return `nonce_${hmacHex('nonce', wallet)}`;
}