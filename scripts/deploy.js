const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const { chainId } = await hre.ethers.provider.getNetwork();

  console.log(`Deploying ToolLending to ${hre.network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const contract = await hre.ethers.deployContract("ToolLending");
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const receipt = await contract.deploymentTransaction().wait();
  console.log(`ToolLending deployed at ${address} (block ${receipt.blockNumber})`);

  const artifact = await hre.artifacts.readArtifact("ToolLending");
  const outFile = path.join(__dirname, "..", "frontend", "src", "deployment.json");
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        network: hre.network.name,
        chainId: Number(chainId),
        address,
        deployBlock: receipt.blockNumber,
        abi: artifact.abi,
      },
      null,
      2
    )
  );
  console.log(`Frontend config written to ${path.relative(process.cwd(), outFile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
