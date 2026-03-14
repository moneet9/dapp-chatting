export const CHAT_REGISTRY_ABI = [
  {
    inputs: [
      { internalType: 'string', name: 'username', type: 'string' },
      { internalType: 'string', name: 'contactKey', type: 'string' },
    ],
    name: 'upsertProfile',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'string', name: 'contactKey', type: 'string' }],
    name: 'resolveContactKey',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'user', type: 'address' }],
    name: 'getProfile',
    outputs: [
      { internalType: 'string', name: 'username', type: 'string' },
      { internalType: 'bytes32', name: 'contactKeyHash', type: 'bytes32' },
      { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
      { internalType: 'bool', name: 'exists', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];
