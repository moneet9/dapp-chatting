# Project Flow and Architecture

## 1. What This Project Is

This project is a hybrid dApp chatting system.

It combines:
- A blockchain layer for wallet-based identity and secret-key lookup
- A MongoDB backend for chats, messages, contacts, login sessions, and realtime app state
- A React frontend for the user interface and chat experience

The goal is to keep the project simple, fast, and cheap to run while still using Web3 concepts where they matter.

## 2. Why I Made It Hybrid

I made it hybrid because not every part of a chat app should be on-chain.

What belongs on-chain:
- Identity-related data
- Username and secret-key lookup logic
- Wallet-based proof that the user owns the address

What belongs off-chain:
- Chat messages
- Contact list data
- Realtime updates
- Presence and session data

This design is better because:
- On-chain storage is expensive
- Chat messages need to be fast and frequent
- MongoDB is better for realtime app data
- The blockchain still adds a Web3 identity layer

## 3. Is This a DApp?

Yes, it is a DApp.

It is decentralized in the identity layer because:
- Users sign in with MetaMask
- The wallet address is the user identity
- The blockchain stores the username and secret-key discovery logic

It is not fully decentralized because:
- Messages are stored in MongoDB, not on-chain
- Contacts and realtime chat state are also stored off-chain

So this is a practical hybrid DApp, not a fully on-chain messenger.

## 4. How the Full Flow Works

### A. Login flow

1. The user clicks Connect Wallet in the frontend.
2. MetaMask returns the wallet address.
3. The backend creates a nonce for that address.
4. The frontend asks MetaMask to sign a login message containing the nonce.
5. The backend verifies the signature.
6. If the signature is valid, the backend issues a JWT token.
7. The frontend stores the token and loads the chat data.

### B. Chat loading flow

1. The frontend fetches the current user profile.
2. It fetches contacts from MongoDB.
3. It fetches chats from MongoDB.
4. It fetches user metadata for visible contacts.
5. It merges contact records with direct chats so the UI can show the conversation list.

### C. Sending a message

1. The user opens a direct chat.
2. The frontend derives the sender secret ID from the wallet address.
3. The frontend derives or loads the contact secret ID.
4. The message text is encrypted in the browser.
5. The encrypted payload is sent to the backend.
6. The backend stores only the encrypted content in MongoDB.
7. The backend updates the chat last message and timestamps.
8. The backend broadcasts the message over Socket.IO so the other user receives it in realtime.

### D. Receiving a message

1. The recipient gets the socket event.
2. The frontend checks whether the contact is known.
3. If needed, the app adds or refreshes the contact entry.
4. If the contact secret exists on that device, the app decrypts the message automatically.
5. If the chat is open, the message appears immediately.

## 5. What MongoDB Is Used For

MongoDB is the main data store for dynamic app data.

MongoDB stores:
- Users
- Contacts
- Chats
- Messages
- Nonces for login

MongoDB is used because:
- It handles frequent writes well
- It is easy to query for chat lists and message history
- It fits realtime app data better than blockchain storage
- It is much cheaper and faster than storing messages on-chain

## 6. What MongoDB Stores Exactly

### Users collection

Stores:
- Opaque user ID
- Username
- Wallet address
- Status and last seen time

### Contacts collection

Stores:
- Owner user ID
- Contact user ID
- Created time

### Chats collection

Stores:
- Chat ID
- Chat type
- Participant IDs
- Last message preview
- Last message time
- Group metadata when needed

### Messages collection

Stores:
- Message ID
- Chat ID
- Sender ID
- Timestamp
- Message type
- Encrypted content
- Optional file metadata

### Nonces collection

Stores:
- Login nonce
- Expiration time

## 7. Are Chats Encrypted in MongoDB?

Yes, the chat messages are encrypted before they are saved.

Important detail:
- MongoDB does not store plain text chat messages
- It stores the encrypted payload in the `encryptedContent` field

That means:
- The database contains ciphertext
- The frontend decrypts the message after loading it
- Without the correct secret IDs, the message content is not readable

## 8. How the Secret Key Is Calculated

The app uses a deterministic secret ID derived from the wallet address.

For a wallet like:

```text
0xabc123...
```

the derived secret ID becomes:

```text
sk-abc123...
```

In code, it is basically:
- normalize the wallet address
- remove the `0x` prefix
- prepend `sk-`

This means the secret key is not random.
It is derived from the wallet address.

Why this matters:
- The same wallet always produces the same secret ID
- The chat key can be recreated after reload
- The system does not need to store a separate random secret for each user

## 9. How Chat Encryption Works

The app encrypts messages in the browser using AES-GCM.

Encryption flow:
1. The sender secret ID is derived from the sender wallet.
2. The contact secret ID is loaded or derived for the other user.
3. Both secret IDs are sorted and combined.
4. A SHA-256 hash is generated from the combined value plus an app scope string.
5. The hash becomes the AES-GCM key.
6. The message text is encrypted with that key.
7. The encrypted JSON payload is stored in MongoDB.

Decryption flow:
1. The message is loaded from MongoDB.
2. The same two secret IDs are reconstructed.
3. The same AES-GCM key is derived again.
4. The ciphertext is decrypted in the browser.

## 10. How MetaMask Login Works

MetaMask is used for wallet authentication.

The login is similar to a SIWE-style flow:

1. The frontend asks the backend for a nonce for the wallet address.
2. The backend stores that nonce temporarily in MongoDB.
3. The frontend asks MetaMask to sign a message containing the nonce.
4. The backend verifies the signature with ethers.js.
5. The backend checks that the recovered address matches the wallet address.
6. If everything is valid, the nonce is cleared.
7. The backend issues a JWT token.
8. The token is used for all authenticated API calls.

Why this is secure:
- The private key never leaves MetaMask
- The app proves wallet ownership by signature
- Nonces prevent replay attacks

## 11. Why MetaMask Matters Here

MetaMask is the identity layer of the app.

It provides:
- Wallet ownership proof
- User login without passwords
- A Web3 identity base for username and secret lookup

This is the main reason the app feels like a dApp rather than a normal chat app.

## 12. How Contact Discovery Works

Contacts are kept in sync from multiple sources:
- User-added contacts
- Direct chats already in MongoDB
- Incoming direct messages

When a message arrives from a new sender:
- The sender can be inserted into the local contact list
- The app can derive the contact secret from the sender wallet
- The chat can be decrypted automatically if the local secret exists

This is why the chat list can keep growing as people message each other.

## 13. What Makes This Project Useful

This project demonstrates:
- Wallet-based login
- Hybrid Web3 and database architecture
- Encrypted messaging
- Realtime chat with Socket.IO
- Contact management tied to identity

It is a good demo because it shows how to combine blockchain identity with practical off-chain storage.

## 14. Simple Summary

In one sentence:

This project is a hybrid dApp chat app where MetaMask proves identity, MongoDB stores encrypted chat data, and the blockchain is used only for the lightweight identity and secret-key layer.