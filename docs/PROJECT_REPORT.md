# Project Report: Neighbourhood Tool Lending System using Blockchain

**Subject:** Blockchain Technology
**Project title:** The Toolshed: A Decentralised Neighbourhood Tool Lending System
**Platform:** Ethereum (Solidity smart contract), Hardhat, ethers.js

---

## 1. Abstract

Most households own tools such as drills, ladders and pressure washers that sit unused for most of the year, while neighbours buy the same items for one-off jobs. Community tool libraries reduce this waste, but they depend on trust: lenders worry about damage and non-return, and borrowers worry about unfair deductions from their deposits. This project implements a decentralised tool lending system on Ethereum. A smart contract acts as a neutral escrow agent. It holds deposits, enforces loan durations, computes late fees from block timestamps, resolves stalled loans through time-outs, and records two-way reputation on an immutable ledger. No central administrator is needed. A web interface built with ethers.js lets residents list tools, borrow them, settle loans and inspect the full on-chain history.

## 2. Introduction

### 2.1 Background
The sharing economy has shown that access can replace ownership. Centralised sharing platforms, however, charge commission, control user data and can change their rules unilaterally. Blockchain technology offers an alternative: rules are encoded in a public smart contract, so they execute exactly as written and anyone can audit them.

### 2.2 Problem statement
Informal lending between neighbours (through WhatsApp groups, for example) suffers from:

1. **Lack of security:** there is no guaranteed compensation if a tool is damaged or not returned.
2. **Disputes:** disagreements about return dates and late penalties.
3. **No accountability:** there is no persistent record of who is a reliable borrower or lender.
4. **Trust in an intermediary:** a centralised platform could withhold funds or manipulate reviews.

### 2.3 Objectives
- Design a smart contract that escrows deposits and rental fees between untrusted parties.
- Model the loan lifecycle as a finite state machine with strict access control.
- Automate late fees and dispute resolution with deterministic, time-based rules.
- Maintain a tamper-proof reputation system.
- Provide a usable web front end and a full automated test suite.

## 3. Existing system vs proposed system

| Aspect | Existing (informal / centralised) | Proposed (blockchain) |
| --- | --- | --- |
| Deposit custody | Lender or platform | Smart contract escrow |
| Rule enforcement | Manual, negotiable | Automatic, coded |
| Late fees | Argued over | Computed from block time |
| Records | Chats, private databases | Public, immutable event log |
| Reviews | Editable / deletable | Permanent, one per party per loan |
| Intermediary fee | Commission | Only network gas |
| Single point of failure | Yes | No |

## 4. System design

### 4.1 Architecture
The system has three layers:

1. **Smart contract layer** (`ToolLending.sol`): business logic, escrow and storage.
2. **Blockchain layer:** Ethereum (a local Hardhat network for development, and the Sepolia testnet for public demos).
3. **Presentation layer:** a Vite web app that uses ethers.js to read contract state, send signed transactions through MetaMask or demo accounts, and subscribe to events.

### 4.2 Actors
- **Member:** a registered resident. Any member can be both a lender (tool owner) and a borrower.
- **Owner (lender):** lists tools, approves or rejects requests, and confirms returns.
- **Borrower:** requests tools, pays the fee and deposit, and returns the tools.

### 4.3 Data model

| Entity | Key fields |
| --- | --- |
| `Member` | name, neighbourhood, joinedAt, loansCompleted, toolsLent, ratingSum, ratingCount, damageReports, defaults |
| `Tool` | id, owner, name, category, description, dailyFee, deposit, listed, currentLoanId, timesLent |
| `Loan` | id, toolId, borrower, lender, durationDays, dailyFee, rentalFee, deposit, requestedAt, startedAt, dueAt, returnedAt, lateFee, damageCharge, status, rated flags |

### 4.4 Functions the contract is built from

| Kind | Example | What it does |
| --- | --- | --- |
| Constructor | `constructor()` | Stores the deployer as `owner` and emits `ContractDeployed`. The owner cannot change loans. |
| Payable | `requestLoan` | Receives the rental fee and deposit in ETH. |
| Pure | `quote` | Computes fee × days + deposit from its arguments only. It reads no storage. |
| View | `getLoan`, `previewLateFee` | Read stored data and change nothing. |
| Event | `LoanRequested`, `ContractDeployed` | Written into the transaction log and shown in the Ledger tab. |

`require` stops a call when an input breaks a rule, for example `require(msg.value == required, "Payment must equal fee plus deposit")`. The failed transaction is discarded and the ETH is returned.

### 4.5 Loan state machine

```
Requested ──approve──▶ Active ──markReturned──▶ Returned ──confirmReturn / finalizeReturn──▶ Completed
    │                    │
    ├─cancel──▶ Cancelled └─(due + 7 days)──claimDefault──▶ Defaulted
    └─reject──▶ Rejected
```

Each transition checks the **caller's role** and the **current state**. Any invalid transition reverts with a custom error, for example `InvalidLoanStatus(current)`.

### 4.6 Money flow

| Event | Borrower | Owner |
| --- | --- | --- |
| Request | pays `fee + deposit` into the contract | — |
| Cancel / Reject | refunded `fee + deposit` | — |
| Approve | — | credited `fee` |
| Complete | credited `deposit − lateFee − damage` | credited `lateFee + damage` |
| Default | — | credited `deposit` |

**Late-fee formula:** `lateDays = ceil((returnedAt − dueAt) / 1 day)`. The fee per day is `2 × dailyFee`, or `deposit / 10` for free tools. The total is capped at the deposit.

## 5. Implementation

### 5.1 Tools and technologies
- **Solidity 0.8.24:** built-in overflow checks. Input rules use `require`. Loan-state failures use custom errors such as `InvalidLoanStatus`.
- **OpenZeppelin Contracts 5:** `ReentrancyGuard`.
- **Hardhat 2:** compilation, local blockchain, testing and deployment scripts.
- **Mocha / Chai / hardhat-network-helpers:** unit tests, including time travel.
- **ethers.js v6:** blockchain client in the browser.
- **Vite:** frontend dev server and bundler.
- **MetaMask:** user wallet and transaction signing.

### 5.2 Key design decisions
1. **Pull-over-push payments:** the contract never sends ETH during business logic. It credits `pendingWithdrawals`, and users call `withdraw()`. This prevents re-entrancy and stops a failing recipient from blocking other users.
2. **Price snapshots:** the daily fee and deposit are copied into the `Loan` record at request time, so the owner cannot change the terms of an existing loan.
3. **One open loan per tool:** `currentLoanId` prevents double-booking.
4. **Time-outs instead of an arbiter:** the 3-day confirmation window and the 7-day default grace period resolve stalled loans without a trusted third party.
5. **Events for every state change:** the frontend's Ledger view is built entirely from these logs, which shows how blockchain provides auditability.
6. **No admin role:** the contract has no owner, pause switch or upgrade path, so it is fully decentralised once deployed.

### 5.3 Frontend screens
- **Browse:** pegboard of tools with search, category filters, availability and the owner's reputation.
- **My Shed:** incoming requests and active loans (approve, reject, confirm return, claim default), the owner's tools, and a form to list a new tool.
- **Borrowing:** the user's loans with due dates, overdue warnings and actions.
- **Ledger:** live feed of contract events with block numbers and transaction hashes.
- **Profile & Wallet:** reputation statistics, profile editing and withdrawable balance.

## 6. Testing

The automated suite (`npm test`) contains **26 test cases** covering:

- registration, duplicate and empty-field validation;
- listing and editing tools, including ownership and on-loan restrictions;
- exact-payment enforcement, duration bounds, own-tool and double-booking prevention;
- cancel and reject refunds and role checks;
- approval, due-date calculation and fee release;
- on-time return, damage claims and the cap on damage charges;
- late-fee calculation for paid and free tools, using simulated time;
- the borrower's self-finalisation after the confirmation window;
- the owner's default claim after the grace period, which also delists the tool;
- reputation: one rating per party, score bounds and the average calculation;
- withdrawals, and the contract balance returning to zero after everyone is settled.

Sample output:

```
  ToolLending
    Membership              ✔ ✔ ✔
    Tool catalogue          ✔ ✔ ✔ ✔
    Requesting a loan       ✔ ✔ ✔
    Cancel / reject         ✔ ✔ ✔
    Approval and return     ✔ ✔ ✔ ✔ ✔ ✔ ✔
    Dispute protection      ✔ ✔
    Reputation              ✔
    Withdrawals             ✔ ✔
    History views           ✔
  26 passing
```

## 7. Security analysis

| Threat | Mitigation |
| --- | --- |
| Re-entrancy on payout | Pull payments + `nonReentrant` + state zeroed before transfer |
| Owner over-charges damage | `damage ≤ deposit − lateFee` enforced on-chain |
| Owner never confirms return | `finalizeReturn` after 3 days |
| Borrower keeps tool | `claimDefault` after due date + 7 days; recorded as a default |
| Changing price mid-loan | Fee and deposit are snapshotted per loan; `updateTool` is blocked while a loan is open |
| Double-booking | `currentLoanId` lock |
| Underpayment or overpayment | Exact `msg.value` check |
| Rating spam | One rating per party per completed loan |

**Known limitations:** the blockchain cannot verify the physical condition of a tool, so damage claims rely on the owner's honesty. They are bounded by the deposit and visible on the owner's record. Timestamps can be shifted slightly by validators (by seconds), which is negligible at day-level granularity.

## 8. Results

The system enables trust-minimised tool lending between neighbours. Every financial outcome is fully determined by the contract's rules and the actions of the two parties. All interactions are publicly auditable, and the reputation built up over time encourages good behaviour without a central authority.

## 9. Future scope

- **Multi-party arbitration:** neighbourhood jurors stake tokens to vote on damage disputes.
- **NFT tool certificates:** represent each tool as an ERC-721 token with on-chain maintenance history.
- **Stablecoin payments:** use USDC or DAI to avoid ETH price volatility.
- **IPFS photos:** store before/after condition photos as evidence.
- **Layer-2 deployment:** deploy on Polygon, Base or Optimism for near-zero fees.
- **Soulbound reputation:** make reputation portable across neighbourhoods.

## 10. Conclusion

This project shows how a smart contract can replace a trusted intermediary in a real community use case. By combining escrow, a strict state machine, time-based dispute resolution and immutable reputation, the Neighbourhood Tool Lending System makes sharing between strangers safe, fair and transparent.

## 11. References

1. Ethereum Foundation, *Solidity Documentation*, https://docs.soliditylang.org
2. Nomic Foundation, *Hardhat Documentation*, https://hardhat.org/docs
3. OpenZeppelin, *Contracts 5.x Documentation*, https://docs.openzeppelin.com/contracts
4. ethers.js v6 Documentation, https://docs.ethers.org/v6
5. ConsenSys, *Smart Contract Security Best Practices*, https://consensys.github.io/smart-contract-best-practices
6. S. Nakamoto, *Bitcoin: A Peer-to-Peer Electronic Cash System*, 2008.
7. V. Buterin, *Ethereum White Paper*, 2014.
