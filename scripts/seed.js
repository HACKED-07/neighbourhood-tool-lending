// Populates a freshly deployed local contract with demo members, tools and loans.
const hre = require("hardhat");
const deployment = require("../frontend/src/deployment.json");

const { parseEther } = hre.ethers;

const MEMBERS = [
  { name: "Asha Kulkarni", area: "Maple Street" },
  { name: "Rohan Mehta", area: "Maple Street" },
  { name: "Priya Nair", area: "Oak Avenue" },
  { name: "Daniel Fernandes", area: "Oak Avenue" },
];

const TOOLS = [
  // [ownerIndex, name, category, description, dailyFee, deposit]
  [0, "Cordless Drill (18V)", "Power Tools", "Bosch drill with two batteries and a 30-piece bit set.", "0.002", "0.05"],
  [0, "Extension Ladder 6m", "Ladders", "Aluminium, lightweight. Great for gutters and painting.", "0.003", "0.08"],
  [1, "Pressure Washer", "Garden", "1800W, includes patio cleaner attachment.", "0.004", "0.1"],
  [1, "Hedge Trimmer", "Garden", "Electric, 55cm blade. Freshly sharpened.", "0", "0.03"],
  [2, "Circular Saw", "Power Tools", "7¼\" blade, laser guide. Safety goggles included.", "0.003", "0.07"],
  [2, "Tile Cutter", "Hand Tools", "Manual cutter for ceramic tiles up to 60cm.", "0.001", "0.02"],
  [3, "Camping Tent (4-person)", "Outdoor", "Waterproof dome tent, sets up in 10 minutes.", "0.002", "0.04"],
  [3, "Stud Finder", "Hand Tools", "Detects wood, metal and live AC wires.", "0", "0.01"],
];

async function main() {
  const signers = (await hre.ethers.getSigners()).slice(1, 1 + MEMBERS.length);
  const contract = await hre.ethers.getContractAt("ToolLending", deployment.address);

  for (let i = 0; i < MEMBERS.length; i++) {
    if (await contract.isMember(signers[i].address)) continue;
    await (await contract.connect(signers[i]).registerMember(MEMBERS[i].name, MEMBERS[i].area)).wait();
    console.log(`Registered ${MEMBERS[i].name} (${signers[i].address})`);
  }

  for (const [owner, name, category, description, fee, deposit] of TOOLS) {
    await (
      await contract.connect(signers[owner]).listTool(name, category, description, parseEther(fee), parseEther(deposit))
    ).wait();
    console.log(`Listed "${name}"`);
  }

  // A completed, rated loan so reputation shows up in the UI.
  const tent = await contract.getTool(7);
  const days = 2n;
  await (await contract.connect(signers[0]).requestLoan(7, days, { value: tent.dailyFee * days + tent.deposit })).wait();
  await (await contract.connect(signers[3]).approveLoan(1)).wait();
  await (await contract.connect(signers[0]).markReturned(1)).wait();
  await (await contract.connect(signers[3]).confirmReturn(1, 0)).wait();
  await (await contract.connect(signers[0]).rate(1, 5)).wait();
  await (await contract.connect(signers[3]).rate(1, 4)).wait();

  // An active loan and a pending request.
  const drill = await contract.getTool(1);
  await (await contract.connect(signers[2]).requestLoan(1, 3, { value: drill.dailyFee * 3n + drill.deposit })).wait();
  await (await contract.connect(signers[0]).approveLoan(2)).wait();

  const washer = await contract.getTool(3);
  await (await contract.connect(signers[3]).requestLoan(3, 1, { value: washer.dailyFee + washer.deposit })).wait();

  console.log("\nDemo data ready. Accounts #1–#4 in the app's demo-account picker are the seeded members.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
