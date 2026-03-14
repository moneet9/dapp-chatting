# dApp Chat Smart Contract (Free Testnet)

This contract keeps the blockchain part minimal for the demo:
- On-chain user profile (username + Secret ID hash)
- Secret ID contact lookup (`resolveContactKey`)

## Setup
```bash
cd contracts
npm install
cp .env.example .env
```

Set values in `.env`:
- `AMOY_RPC_URL` or `SEPOLIA_RPC_URL`
- `PRIVATE_KEY` (test wallet only)

## Compile
```bash
npm run compile
```

## Deploy (free testnet gas via faucet)
```bash
npm run deploy:amoy
# or
npm run deploy:sepolia
```

## Why this is blockchain-based
- User identity is still wallet-based.
- Username + Secret ID lookup is verifiable on-chain.
- Chat messages remain in MongoDB so the demo stays fast and cheap.

## Frontend Integration
After deploy, copy contract address into frontend env:

```bash
cd frontend
cp .env.example .env
# set VITE_CHAT_REGISTRY_ADDRESS
```
