# dApp Chatting Workspace

This workspace now has:
- `frontend/` - your React Web3 chat frontend
- `backend/` - free Node.js API + Socket.IO realtime server
- `contracts/` - Hardhat smart contract project for username + Secret ID lookup

## Quick Start

### 1) Backend
```bash
cd backend
npm install
cp .env.example.env .env
npm run dev
```

Set these backend env values:
- `MONGODB_URI`
- `MONGODB_DB_NAME`

### 2) Contract
```bash
cd ../contracts
npm install
cp .env.example .env
npm run compile
```

### 3) Frontend
Set env in your frontend:
- `VITE_API_URL=http://localhost:3001/api`
- `VITE_SOCKET_URL=http://localhost:3001`

Then run frontend normally.

## Demo Architecture
- MongoDB stores chats, messages, contacts cache, and realtime presence.
- Blockchain stores username + Secret ID lookup only.
- MetaMask handles wallet login and identity.
