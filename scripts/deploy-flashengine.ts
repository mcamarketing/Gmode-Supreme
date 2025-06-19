import { ethers } from "hardhat";

async function main() {
  console.log("Deploying FlashEngine contract...");

  // Get deployment account
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // Check balance
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "MATIC");

  // Contract addresses on Polygon
  const AAVE_ADDRESSES_PROVIDER = "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb"; // Aave V3 Polygon
  const PLATFORM_WALLET = process.env.PLATFORM_WALLET || deployer.address;

  // Deploy FlashEngine
  const FlashEngine = await ethers.getContractFactory("FlashEngine");
  const flashEngine = await FlashEngine.deploy(
    AAVE_ADDRESSES_PROVIDER,
    PLATFORM_WALLET
  );

  await flashEngine.waitForDeployment();
  const contractAddress = await flashEngine.getAddress();

  console.log("FlashEngine deployed to:", contractAddress);
  console.log("Platform wallet:", PLATFORM_WALLET);

  // Verify contract on Polygonscan
  if (process.env.POLYGONSCAN_API_KEY) {
    console.log("Waiting for block confirmations...");
    await flashEngine.deploymentTransaction()?.wait(5);

    console.log("Verifying contract on Polygonscan...");
    try {
      await run("verify:verify", {
        address: contractAddress,
        constructorArguments: [AAVE_ADDRESSES_PROVIDER, PLATFORM_WALLET],
      });
      console.log("Contract verified successfully!");
    } catch (error) {
      console.error("Verification failed:", error);
    }
  }

  // Save deployment info
  const deploymentInfo = {
    network: network.name,
    contractAddress,
    deployer: deployer.address,
    platformWallet: PLATFORM_WALLET,
    aaveAddressesProvider: AAVE_ADDRESSES_PROVIDER,
    deploymentTime: new Date().toISOString(),
    blockNumber: await ethers.provider.getBlockNumber(),
  };

  console.log("\n=== Deployment Complete ===");
  console.log(JSON.stringify(deploymentInfo, null, 2));
  console.log("\nSave the contract address in your .env file:");
  console.log(`FLASH_ENGINE_ADDRESS=${contractAddress}`);
}

// Run deployment
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });