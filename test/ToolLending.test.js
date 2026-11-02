const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const Status = { Requested: 0, Active: 1, Returned: 2, Completed: 3, Rejected: 4, Cancelled: 5, Defaulted: 6 };

describe("ToolLending", function () {
  const DAILY_FEE = ethers.parseEther("0.01");
  const DEPOSIT = ethers.parseEther("0.1");

  async function deployFixture() {
    const [owner, borrower, stranger, unregistered] = await ethers.getSigners();
    const lending = await ethers.deployContract("ToolLending");

    await lending.connect(owner).registerMember("Asha", "Maple Street");
    await lending.connect(borrower).registerMember("Rohan", "Maple Street");
    await lending.connect(stranger).registerMember("Priya", "Oak Avenue");
    await lending.connect(owner).listTool("Drill", "Power Tools", "18V cordless", DAILY_FEE, DEPOSIT);

    return { lending, owner, borrower, stranger, unregistered };
  }

  async function requestedFixture() {
    const ctx = await deployFixture();
    const days = 3;
    const value = DAILY_FEE * BigInt(days) + DEPOSIT;
    await ctx.lending.connect(ctx.borrower).requestLoan(1, days, { value });
    return { ...ctx, days, value };
  }

  async function activeFixture() {
    const ctx = await requestedFixture();
    await ctx.lending.connect(ctx.owner).approveLoan(1);
    return ctx;
  }

  async function returnedFixture() {
    const ctx = await activeFixture();
    await ctx.lending.connect(ctx.borrower).markReturned(1);
    return ctx;
  }

  describe("Constructor and quote", function () {
    it("stores the deployer and emits ContractDeployed", async function () {
      const [deployer] = await ethers.getSigners();
      const lending = await ethers.deployContract("ToolLending");
      await expect(lending.deploymentTransaction()).to.emit(lending, "ContractDeployed").withArgs(deployer.address, await lending.deployedAt());
      expect(await lending.owner()).to.equal(deployer.address);
    });

    it("quotes fee plus deposit with require, and reads no storage", async function () {
      const { lending } = await loadFixture(deployFixture);
      expect(await lending.quote.staticCall(DAILY_FEE, 3, DEPOSIT)).to.deep.equal([DAILY_FEE * 3n, DAILY_FEE * 3n + DEPOSIT]);
      await expect(lending.quote.staticCall(DAILY_FEE, 0, DEPOSIT)).to.be.revertedWith("Duration must be 1 to 30 days");
      await expect(lending.quote.staticCall(DAILY_FEE, 2, 0)).to.be.revertedWith("Deposit required");
    });
  });

  describe("Membership", function () {
    it("registers a member and emits an event", async function () {
      const { lending, unregistered } = await loadFixture(deployFixture);
      await expect(lending.connect(unregistered).registerMember("Dan", "Oak Avenue"))
        .to.emit(lending, "MemberRegistered")
        .withArgs(unregistered.address, "Dan", "Oak Avenue");

      const m = await lending.getMember(unregistered.address);
      expect(m.registered).to.equal(true);
      expect(m.name).to.equal("Dan");
      expect(await lending.memberCount()).to.equal(4);
    });

    it("rejects duplicate registration and empty fields", async function () {
      const { lending, owner, unregistered } = await loadFixture(deployFixture);
      await expect(lending.connect(owner).registerMember("A", "B")).to.be.revertedWith("Already registered");
      await expect(lending.connect(unregistered).registerMember("", "B")).to.be.revertedWith("Name and neighbourhood required");
    });

    it("lets a member update their profile", async function () {
      const { lending, owner } = await loadFixture(deployFixture);
      await lending.connect(owner).updateProfile("Asha K", "Elm Road");
      const m = await lending.getMember(owner.address);
      expect(m.name).to.equal("Asha K");
      expect(m.neighbourhood).to.equal("Elm Road");
    });
  });

  describe("Tool catalogue", function () {
    it("only lets members list tools", async function () {
      const { lending, unregistered } = await loadFixture(deployFixture);
      await expect(
        lending.connect(unregistered).listTool("Saw", "Power Tools", "", DAILY_FEE, DEPOSIT)
      ).to.be.revertedWith("Register as a member first");
    });

    it("requires a non-zero deposit", async function () {
      const { lending, owner } = await loadFixture(deployFixture);
      await expect(lending.connect(owner).listTool("Saw", "Power Tools", "", DAILY_FEE, 0)).to.be.revertedWith("Deposit required");
    });

    it("stores the tool and indexes it by owner", async function () {
      const { lending, owner } = await loadFixture(deployFixture);
      const tool = await lending.getTool(1);
      expect(tool.owner).to.equal(owner.address);
      expect(tool.dailyFee).to.equal(DAILY_FEE);
      expect(tool.listed).to.equal(true);
      expect(await lending.getAllTools()).to.have.length(1);
      expect(await lending.getToolsByOwner(owner.address)).to.have.length(1);
    });

    it("lets only the owner update a tool, and not while on loan", async function () {
      const { lending, owner, borrower } = await loadFixture(requestedFixture);
      await expect(lending.connect(borrower).updateTool(1, 0, DEPOSIT, true)).to.be.revertedWith("Only the tool owner can update it");
      await expect(lending.connect(owner).updateTool(1, 0, DEPOSIT, true)).to.be.revertedWith("Cannot edit a tool while it is on loan");
    });
  });

  describe("Requesting a loan", function () {
    it("escrows fee + deposit and locks the tool", async function () {
      const { lending, borrower } = await loadFixture(deployFixture);
      const value = DAILY_FEE * 3n + DEPOSIT;
      await expect(lending.connect(borrower).requestLoan(1, 3, { value })).to.changeEtherBalances(
        [borrower, lending],
        [-value, value]
      );

      const loan = await lending.getLoan(1);
      expect(loan.borrower).to.equal(borrower.address);
      expect(loan.status).to.equal(Status.Requested);
      expect(loan.rentalFee + loan.deposit).to.equal(value);
      expect((await lending.getTool(1)).currentLoanId).to.equal(1);
    });

    it("rejects wrong payment, bad duration, own tool and busy tool", async function () {
      const { lending, owner, borrower, stranger } = await loadFixture(deployFixture);
      const value = DAILY_FEE * 2n + DEPOSIT;

      await expect(lending.connect(borrower).requestLoan(1, 2, { value: value - 1n })).to.be.revertedWith(
        "Payment must equal fee plus deposit"
      );
      await expect(lending.connect(borrower).requestLoan(1, 0, { value: DEPOSIT })).to.be.revertedWith("Duration must be 1 to 30 days");
      await expect(lending.connect(borrower).requestLoan(1, 31, { value })).to.be.revertedWith("Duration must be 1 to 30 days");
      await expect(lending.connect(owner).requestLoan(1, 2, { value })).to.be.revertedWith("Cannot borrow your own tool");

      await lending.connect(borrower).requestLoan(1, 2, { value });
      await expect(lending.connect(stranger).requestLoan(1, 2, { value })).to.be.revertedWith("Tool is already reserved");
    });

    it("rejects requests for unlisted or unknown tools", async function () {
      const { lending, owner, borrower } = await loadFixture(deployFixture);
      await lending.connect(owner).updateTool(1, DAILY_FEE, DEPOSIT, false);
      await expect(lending.connect(borrower).requestLoan(1, 1, { value: DAILY_FEE + DEPOSIT })).to.be.revertedWith("Tool is not listed");
      await expect(lending.getTool(99)).to.be.revertedWithCustomError(lending, "ToolNotFound");
    });
  });

  describe("Cancel / reject", function () {
    it("refunds the borrower in full when they cancel", async function () {
      const { lending, borrower, value } = await loadFixture(requestedFixture);
      await expect(lending.connect(borrower).cancelRequest(1)).to.emit(lending, "LoanCancelled").withArgs(1);
      expect(await lending.pendingWithdrawals(borrower.address)).to.equal(value);
      expect((await lending.getTool(1)).currentLoanId).to.equal(0);
    });

    it("refunds the borrower in full when the owner rejects", async function () {
      const { lending, owner, borrower, value } = await loadFixture(requestedFixture);
      await lending.connect(owner).rejectRequest(1);
      expect((await lending.getLoan(1)).status).to.equal(Status.Rejected);
      expect(await lending.pendingWithdrawals(borrower.address)).to.equal(value);
    });

    it("enforces who may cancel or reject", async function () {
      const { lending, owner, borrower } = await loadFixture(requestedFixture);
      await expect(lending.connect(owner).cancelRequest(1)).to.be.revertedWithCustomError(lending, "NotBorrower");
      await expect(lending.connect(borrower).rejectRequest(1)).to.be.revertedWithCustomError(lending, "NotLender");
    });
  });

  describe("Approval and return", function () {
    it("starts the loan, sets the due date and pays the rental fee to the owner", async function () {
      const { lending, owner, days } = await loadFixture(requestedFixture);
      await lending.connect(owner).approveLoan(1);
      const loan = await lending.getLoan(1);
      expect(loan.status).to.equal(Status.Active);
      expect(loan.dueAt - loan.startedAt).to.equal(BigInt(days * DAY));
      expect(await lending.pendingWithdrawals(owner.address)).to.equal(DAILY_FEE * BigInt(days));
    });

    it("cannot approve twice", async function () {
      const { lending, owner } = await loadFixture(activeFixture);
      await expect(lending.connect(owner).approveLoan(1))
        .to.be.revertedWithCustomError(lending, "InvalidLoanStatus")
        .withArgs(Status.Active);
    });

    it("refunds the full deposit on an on-time, undamaged return", async function () {
      const { lending, owner, borrower } = await loadFixture(returnedFixture);
      await expect(lending.connect(owner).confirmReturn(1, 0))
        .to.emit(lending, "LoanCompleted")
        .withArgs(1, 0, 0, DEPOSIT);

      expect(await lending.pendingWithdrawals(borrower.address)).to.equal(DEPOSIT);
      const tool = await lending.getTool(1);
      expect(tool.currentLoanId).to.equal(0);
      expect(tool.timesLent).to.equal(1);
      expect((await lending.getMember(borrower.address)).loansCompleted).to.equal(1);
      expect((await lending.getMember(owner.address)).toolsLent).to.equal(1);
    });

    it("lets the owner claim part of the deposit for damage", async function () {
      const { lending, owner, borrower, days } = await loadFixture(returnedFixture);
      const damage = ethers.parseEther("0.04");
      await lending.connect(owner).confirmReturn(1, damage);

      expect(await lending.pendingWithdrawals(borrower.address)).to.equal(DEPOSIT - damage);
      expect(await lending.pendingWithdrawals(owner.address)).to.equal(DAILY_FEE * BigInt(days) + damage);
      expect((await lending.getMember(borrower.address)).damageReports).to.equal(1);
    });

    it("caps damage claims at the deposit", async function () {
      const { lending, owner } = await loadFixture(returnedFixture);
      await expect(lending.connect(owner).confirmReturn(1, DEPOSIT + 1n))
        .to.be.revertedWithCustomError(lending, "ChargesExceedDeposit")
        .withArgs(DEPOSIT);
    });

    it("charges a late fee of 2x the daily fee per started overdue day", async function () {
      const { lending, owner, borrower, days } = await loadFixture(activeFixture);
      const loan = await lending.getLoan(1);
      await time.increaseTo(loan.dueAt + BigInt(DAY + 60)); // 1 day + 1 minute late → 2 days
      await lending.connect(borrower).markReturned(1);
      await lending.connect(owner).confirmReturn(1, 0);

      const lateFee = DAILY_FEE * 2n * 2n;
      expect((await lending.getLoan(1)).lateFee).to.equal(lateFee);
      expect(await lending.pendingWithdrawals(borrower.address)).to.equal(DEPOSIT - lateFee);
      expect(await lending.pendingWithdrawals(owner.address)).to.equal(DAILY_FEE * BigInt(days) + lateFee);
    });

    it("uses deposit/10 per day as the late fee for free tools, capped at the deposit", async function () {
      const { lending, owner, borrower } = await loadFixture(deployFixture);
      await lending.connect(owner).listTool("Ladder", "Ladders", "", 0, DEPOSIT);
      await lending.connect(borrower).requestLoan(2, 1, { value: DEPOSIT });
      await lending.connect(owner).approveLoan(1);

      const loan = await lending.getLoan(1);
      expect(await lending.previewLateFee(1, loan.dueAt + BigInt(3 * DAY))).to.equal(DEPOSIT * 3n / 10n);
      expect(await lending.previewLateFee(1, loan.dueAt + BigInt(30 * DAY))).to.equal(DEPOSIT);
    });
  });

  describe("Dispute protection", function () {
    it("lets the borrower self-finalise if the owner does not confirm within 3 days", async function () {
      const { lending, borrower } = await loadFixture(returnedFixture);
      await expect(lending.connect(borrower).finalizeReturn(1)).to.be.revertedWithCustomError(lending, "ConfirmationWindowOpen");

      await time.increase(3 * DAY);
      await lending.connect(borrower).finalizeReturn(1);
      expect((await lending.getLoan(1)).status).to.equal(Status.Completed);
      expect(await lending.pendingWithdrawals(borrower.address)).to.equal(DEPOSIT);
    });

    it("lets the owner claim the deposit if the tool is not returned after the grace period", async function () {
      const { lending, owner, borrower, days } = await loadFixture(activeFixture);
      const loan = await lending.getLoan(1);

      await expect(lending.connect(owner).claimDefault(1)).to.be.revertedWithCustomError(lending, "GracePeriodActive");
      await time.increaseTo(loan.dueAt + BigInt(7 * DAY + 1));

      await expect(lending.connect(owner).claimDefault(1)).to.emit(lending, "LoanDefaulted").withArgs(1, DEPOSIT);
      expect(await lending.pendingWithdrawals(owner.address)).to.equal(DAILY_FEE * BigInt(days) + DEPOSIT);
      expect((await lending.getMember(borrower.address)).defaults).to.equal(1);

      const tool = await lending.getTool(1);
      expect(tool.listed).to.equal(false);
      expect(tool.currentLoanId).to.equal(0);
    });
  });

  describe("Reputation", function () {
    it("lets each party rate the other exactly once", async function () {
      const { lending, owner, borrower, stranger } = await loadFixture(returnedFixture);
      await expect(lending.connect(borrower).rate(1, 5)).to.be.revertedWithCustomError(lending, "InvalidLoanStatus");
      await lending.connect(owner).confirmReturn(1, 0);

      await expect(lending.connect(borrower).rate(1, 5))
        .to.emit(lending, "MemberRated")
        .withArgs(1, borrower.address, owner.address, 5);
      await lending.connect(owner).rate(1, 4);

      await expect(lending.connect(borrower).rate(1, 5)).to.be.revertedWithCustomError(lending, "AlreadyRated");
      await expect(lending.connect(stranger).rate(1, 5)).to.be.revertedWithCustomError(lending, "NotParticipant");
      await expect(lending.connect(owner).rate(1, 6)).to.be.revertedWith("Score must be from 1 to 5");

      expect(await lending.reputationOf(owner.address)).to.equal(500);
      expect(await lending.reputationOf(borrower.address)).to.equal(400);
      expect(await lending.reputationOf(stranger.address)).to.equal(0);
    });
  });

  describe("Withdrawals", function () {
    it("pays out the pending balance and zeroes it", async function () {
      const { lending, owner, borrower } = await loadFixture(returnedFixture);
      await lending.connect(owner).confirmReturn(1, 0);

      await expect(lending.connect(borrower).withdraw()).to.changeEtherBalances([borrower, lending], [DEPOSIT, -DEPOSIT]);
      expect(await lending.pendingWithdrawals(borrower.address)).to.equal(0);
      await expect(lending.connect(borrower).withdraw()).to.be.revertedWithCustomError(lending, "NothingToWithdraw");
    });

    it("leaves the contract empty once everyone has withdrawn", async function () {
      const { lending, owner, borrower } = await loadFixture(returnedFixture);
      await lending.connect(owner).confirmReturn(1, ethers.parseEther("0.01"));
      await lending.connect(owner).withdraw();
      await lending.connect(borrower).withdraw();
      expect(await ethers.provider.getBalance(await lending.getAddress())).to.equal(0);
    });
  });

  describe("History views", function () {
    it("returns loans per borrower and per lender", async function () {
      const { lending, owner, borrower } = await loadFixture(requestedFixture);
      expect(await lending.getLoansByBorrower(borrower.address)).to.have.length(1);
      expect(await lending.getLoansByLender(owner.address)).to.have.length(1);
      expect(await lending.getLoansByLender(borrower.address)).to.have.length(0);
    });
  });
});
