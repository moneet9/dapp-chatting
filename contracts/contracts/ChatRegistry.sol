// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract ChatRegistry {
    struct Profile {
        string username;
        bytes32 contactKeyHash;
        uint256 updatedAt;
        bool exists;
    }

    mapping(address => Profile) private profiles;
    mapping(bytes32 => address) private contactKeyOwner;

    event ProfileUpdated(address indexed user, string username, bytes32 indexed contactKeyHash);

    function upsertProfile(string calldata username, string calldata contactKey) external {
        bytes memory usernameBytes = bytes(username);
        require(usernameBytes.length >= 2 && usernameBytes.length <= 32, 'Invalid username length');

        bytes32 keyHash = _hashContactKey(contactKey);
        address owner = contactKeyOwner[keyHash];
        require(owner == address(0) || owner == msg.sender, 'Secret key already in use');

        Profile storage currentProfile = profiles[msg.sender];
        if (currentProfile.exists && currentProfile.contactKeyHash != bytes32(0) && currentProfile.contactKeyHash != keyHash) {
            delete contactKeyOwner[currentProfile.contactKeyHash];
        }

        contactKeyOwner[keyHash] = msg.sender;
        profiles[msg.sender] = Profile({
            username: username,
            contactKeyHash: keyHash,
            updatedAt: block.timestamp,
            exists: true
        });

        emit ProfileUpdated(msg.sender, username, keyHash);
    }

    function getProfile(address user) external view returns (string memory username, bytes32 contactKeyHash, uint256 updatedAt, bool exists) {
        Profile memory profile = profiles[user];
        return (profile.username, profile.contactKeyHash, profile.updatedAt, profile.exists);
    }

    function resolveContactKey(string calldata contactKey) external view returns (address) {
        return contactKeyOwner[_hashContactKey(contactKey)];
    }

    function _hashContactKey(string calldata contactKey) internal pure returns (bytes32) {
        bytes memory keyBytes = bytes(contactKey);
        require(keyBytes.length >= 6 && keyBytes.length <= 64, 'Secret key length must be 6-64');
        return keccak256(abi.encodePacked(contactKey));
    }
}
