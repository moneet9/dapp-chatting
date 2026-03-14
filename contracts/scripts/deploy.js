const hre = require('hardhat');

async function main() {
  const ChatRegistry = await hre.ethers.getContractFactory('ChatRegistry');
  const registry = await ChatRegistry.deploy();
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  console.log('ChatRegistry deployed to:', address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
