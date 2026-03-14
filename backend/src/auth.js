import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';
import { config } from './config.js';
import { clearNonce, getNonceRecord } from './store.js';

export async function verifyLoginSignature({ address, signature, message }) {
  if (!address || !signature || !message) {
    return { error: 'address, signature and message are required' };
  }

  const nonceRecord = await getNonceRecord(address);
  if (!nonceRecord) {
    return { error: 'Nonce missing or already used' };
  }
  if (nonceRecord.expiresAt < Date.now()) {
    await clearNonce(address);
    return { error: 'Nonce expired' };
  }
  if (!message.includes(nonceRecord.nonce)) {
    return { error: 'Nonce mismatch in signed message' };
  }

  const recoveredAddress = ethers.verifyMessage(message, signature).toLowerCase();
  if (recoveredAddress !== address.toLowerCase()) {
    return { error: 'Invalid signature' };
  }

  await clearNonce(address);

  return { ok: true };
}

export function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      address: user.address,
      username: user.username,
    },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Missing Bearer token' });
  }

  const token = authHeader.slice('Bearer '.length);
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.user = {
      id: decoded.sub,
      address: decoded.address,
      username: decoded.username,
    };
    return next();
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

export function verifySocketToken(token) {
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    return {
      id: decoded.sub,
      address: decoded.address,
      username: decoded.username,
    };
  } catch {
    return null;
  }
}
