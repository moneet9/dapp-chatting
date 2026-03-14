# dApp Chat Backend (Free MVP)

This backend is built for a lightweight demo architecture:
- Blockchain: wallet login identity plus username/Secret ID discovery.
- MongoDB: realtime messaging, contacts, auth sessions, and presence.

## Stack
- Node.js + Express
- Socket.IO for realtime
- JWT auth
- SIWE-style nonce + wallet signature verification
- MongoDB Atlas (or local MongoDB)

## Run
1. Install dependencies:
   ```bash
   cd backend
   npm install
   ```
2. Copy env:
   ```bash
   cp .env.example.env .env
   ```
3. Set MongoDB values in `.env`:
   - `MONGODB_URI`
   - `MONGODB_DB_NAME`
4. Start dev server:
   ```bash
   npm run dev
   ```
5. API URL:
   - `http://localhost:3001/api`

## API Endpoints
- `GET /api/health`
- `GET /api/auth/nonce/:address`
- `POST /api/auth/login`
- `GET /api/me` (auth)
- `PATCH /api/me` (auth)
- `GET /api/contacts` (auth)
- `POST /api/contacts` (auth)
- `GET /api/users` (auth)
- `GET /api/users/search?q=...` (auth)
- `GET /api/chats` (auth)
- `GET /api/chats/:chatId` (auth)
- `POST /api/chats` (auth)
- `GET /api/messages/:chatId` (auth)
- `POST /api/messages` (auth)

Direct chat demo note:
- Chats and messages are stored only in MongoDB.
- The blockchain is not used for message storage.

## Socket Events
Client -> Server:
- `chat:join`
- `chat:leave`
- `message:send`
- `typing:start`
- `typing:stop`
- `message:read`

Server -> Client:
- `message:new`
- `message:status`
- `typing:update`
- `user:status`
- `error`

## Free Deployment Options
- Render (free tier)
- Railway (free starter credits)
- Localhost for demo

For production, use a restricted MongoDB user and keep secrets out of version control.
