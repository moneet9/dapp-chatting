import dotenv from 'dotenv';

dotenv.config();

const defaultMongoUri = 'mongodb://127.0.0.1:27017/dapp-chatting';

export const config = {
  port: Number(process.env.PORT || 3001),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret',
  privacySecret: process.env.PRIVACY_SECRET || 'dev-privacy-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  chainId: Number(process.env.CHAIN_ID || 80002),
  mongodbUri: process.env.MONGODB_URI || defaultMongoUri,
  mongodbDbName: process.env.MONGODB_DB_NAME || 'dapp-chatting',
};
