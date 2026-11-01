// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title  ToolLending
 * @notice A trust-minimised tool lending library for a neighbourhood.
 *
 *         Owners list tools with a daily fee and a refundable security deposit.
 *         Borrowers lock fee + deposit in escrow when they request a tool. The
 *         contract releases funds according to the loan outcome:
 *
 *           Requested ──approve──▶ Active ──markReturned──▶ Returned ──confirm/finalize──▶ Completed
 *               │                    │
 *               ├─reject/cancel──▶ Rejected / Cancelled (full refund)
 *               │                    └─(overdue + grace)──claimDefault──▶ Defaulted (deposit to owner)
 *
 *         All payouts use the pull-payment pattern: balances are credited
 *         internally and members call `withdraw()` to receive ETH.
 */
contract ToolLending is ReentrancyGuard {
    // ───────────────────────────── Constants ─────────────────────────────

    uint256 public constant MAX_LOAN_DAYS = 30;
    /// @notice Time the owner has to inspect a returned tool before the borrower may self-finalise.
    uint256 public constant RETURN_CONFIRMATION_WINDOW = 3 days;
    /// @notice Extra time after the due date before an owner may treat the loan as defaulted.
    uint256 public constant DEFAULT_GRACE_PERIOD = 7 days;
    /// @notice Late fee per overdue day, as a multiple of the daily fee.
    uint256 public constant LATE_FEE_MULTIPLIER = 2;
    /// @notice For free tools, the late fee per overdue day is deposit / this value.
    uint256 public constant FREE_TOOL_LATE_FEE_DIVISOR = 10;

    // ───────────────────────────── Types ─────────────────────────────

    enum LoanStatus {
        Requested,
        Active,
        Returned,
        Completed,
        Rejected,
        Cancelled,
        Defaulted
    }

    struct Member {
        string name;
        string neighbourhood;
        bool registered;
        uint64 joinedAt;
        uint32 loansCompleted;
        uint32 toolsLent;
        uint32 ratingCount;
        uint32 ratingSum;
        uint32 damageReports;
        uint32 defaults;
    }

    struct Tool {
        uint256 id;
        address owner;
        string name;
        string category;
        string description;
        uint256 dailyFee;
        uint256 deposit;
        bool listed;
        uint256 currentLoanId; // 0 when the tool is free
        uint32 timesLent;
    }

    struct Loan {
        uint256 id;
        uint256 toolId;
        address borrower;
        address lender;
        uint32 durationDays;
        uint256 dailyFee;
        uint256 rentalFee;
        uint256 deposit;
        uint64 requestedAt;
        uint64 startedAt;
        uint64 dueAt;
        uint64 returnedAt;
        uint256 lateFee;
        uint256 damageCharge;
        LoanStatus status;
        bool borrowerRated;
        bool lenderRated;
    }

    // ───────────────────────────── Storage ─────────────────────────────

    mapping(address => Member) private _members;
    address[] private _memberList;

    mapping(uint256 => Tool) private _tools;
    uint256 public toolCount;

    mapping(uint256 => Loan) private _loans;
    uint256 public loanCount;

    mapping(address => uint256[]) private _toolsByOwner;
    mapping(address => uint256[]) private _loansByBorrower;
    mapping(address => uint256[]) private _loansByLender;

    mapping(address => uint256) public pendingWithdrawals;

    // ───────────────────────────── Events ─────────────────────────────

    event MemberRegistered(address indexed member, string name, string neighbourhood);
    event ProfileUpdated(address indexed member, string name, string neighbourhood);
    event ToolListed(uint256 indexed toolId, address indexed owner, string name, uint256 dailyFee, uint256 deposit);
    event ToolUpdated(uint256 indexed toolId, uint256 dailyFee, uint256 deposit, bool listed);
    event LoanRequested(uint256 indexed loanId, uint256 indexed toolId, address indexed borrower, uint32 durationDays, uint256 amountLocked);
    event LoanCancelled(uint256 indexed loanId);
    event LoanRejected(uint256 indexed loanId);
    event LoanApproved(uint256 indexed loanId, uint64 dueAt);
    event ToolMarkedReturned(uint256 indexed loanId, uint64 returnedAt);
    event LoanCompleted(uint256 indexed loanId, uint256 lateFee, uint256 damageCharge, uint256 depositRefund);
    event LoanDefaulted(uint256 indexed loanId, uint256 depositClaimed);
    event MemberRated(uint256 indexed loanId, address indexed rater, address indexed ratee, uint8 score);
    event Withdrawal(address indexed member, uint256 amount);

    // ───────────────────────────── Errors ─────────────────────────────

    error NotRegistered();
    error AlreadyRegistered();
    error EmptyField();
    error ToolNotFound();
    error LoanNotFound();
    error NotToolOwner();
    error NotBorrower();
    error NotLender();
    error NotParticipant();
    error ToolNotListed();
    error ToolUnavailable();
    error ToolOnLoan();
    error CannotBorrowOwnTool();
    error InvalidDuration();
    error InvalidDeposit();
    error IncorrectPayment(uint256 expected, uint256 received);
    error InvalidLoanStatus(LoanStatus current);
    error ConfirmationWindowOpen(uint64 availableAt);
    error GracePeriodActive(uint64 availableAt);
    error ChargesExceedDeposit(uint256 maxDamageCharge);
    error InvalidScore();
    error AlreadyRated();
    error NothingToWithdraw();
    error TransferFailed();

    // ───────────────────────────── Modifiers ─────────────────────────────

    modifier onlyMember() {
        if (!_members[msg.sender].registered) revert NotRegistered();
        _;
    }

    // ───────────────────────────── Membership ─────────────────────────────

    function registerMember(string calldata name, string calldata neighbourhood) external {
        if (_members[msg.sender].registered) revert AlreadyRegistered();
        if (bytes(name).length == 0 || bytes(neighbourhood).length == 0) revert EmptyField();

        Member storage m = _members[msg.sender];
        m.name = name;
        m.neighbourhood = neighbourhood;
        m.registered = true;
        m.joinedAt = uint64(block.timestamp);
        _memberList.push(msg.sender);

        emit MemberRegistered(msg.sender, name, neighbourhood);
    }

    function updateProfile(string calldata name, string calldata neighbourhood) external onlyMember {
        if (bytes(name).length == 0 || bytes(neighbourhood).length == 0) revert EmptyField();
        Member storage m = _members[msg.sender];
        m.name = name;
        m.neighbourhood = neighbourhood;
        emit ProfileUpdated(msg.sender, name, neighbourhood);
    }

    // ───────────────────────────── Tool catalogue ─────────────────────────────

    function listTool(
        string calldata name,
        string calldata category,
        string calldata description,
        uint256 dailyFee,
        uint256 deposit
    ) external onlyMember returns (uint256 toolId) {
        if (bytes(name).length == 0 || bytes(category).length == 0) revert EmptyField();
        if (deposit == 0) revert InvalidDeposit();

        toolId = ++toolCount;
        Tool storage t = _tools[toolId];
        t.id = toolId;
        t.owner = msg.sender;
        t.name = name;
        t.category = category;
        t.description = description;
        t.dailyFee = dailyFee;
        t.deposit = deposit;
        t.listed = true;
        _toolsByOwner[msg.sender].push(toolId);

        emit ToolListed(toolId, msg.sender, name, dailyFee, deposit);
    }

    /// @notice Change pricing or (un)list a tool. Not allowed while a loan is in progress.
    function updateTool(uint256 toolId, uint256 dailyFee, uint256 deposit, bool listed) external {
        Tool storage t = _getTool(toolId);
        if (t.owner != msg.sender) revert NotToolOwner();
        if (t.currentLoanId != 0) revert ToolOnLoan();
        if (deposit == 0) revert InvalidDeposit();

        t.dailyFee = dailyFee;
        t.deposit = deposit;
        t.listed = listed;

        emit ToolUpdated(toolId, dailyFee, deposit, listed);
    }

    // ───────────────────────────── Loan lifecycle ─────────────────────────────

    /// @notice Request a tool. `msg.value` must equal `dailyFee * durationDays + deposit`.
    function requestLoan(uint256 toolId, uint32 durationDays) external payable onlyMember returns (uint256 loanId) {
        Tool storage t = _getTool(toolId);
        if (!t.listed) revert ToolNotListed();
        if (t.currentLoanId != 0) revert ToolUnavailable();
        if (t.owner == msg.sender) revert CannotBorrowOwnTool();
        if (durationDays == 0 || durationDays > MAX_LOAN_DAYS) revert InvalidDuration();

        uint256 rentalFee = t.dailyFee * durationDays;
        uint256 required = rentalFee + t.deposit;
        if (msg.value != required) revert IncorrectPayment(required, msg.value);

        loanId = ++loanCount;
        Loan storage l = _loans[loanId];
        l.id = loanId;
        l.toolId = toolId;
        l.borrower = msg.sender;
        l.lender = t.owner;
        l.durationDays = durationDays;
        l.dailyFee = t.dailyFee;
        l.rentalFee = rentalFee;
        l.deposit = t.deposit;
        l.requestedAt = uint64(block.timestamp);
        l.status = LoanStatus.Requested;

        t.currentLoanId = loanId;
        _loansByBorrower[msg.sender].push(loanId);
        _loansByLender[t.owner].push(loanId);

        emit LoanRequested(loanId, toolId, msg.sender, durationDays, required);
    }

    function cancelRequest(uint256 loanId) external {
        Loan storage l = _getLoan(loanId);
        if (l.borrower != msg.sender) revert NotBorrower();
        _requireStatus(l, LoanStatus.Requested);

        l.status = LoanStatus.Cancelled;
        _releaseTool(l.toolId);
        _credit(l.borrower, l.rentalFee + l.deposit);

        emit LoanCancelled(loanId);
    }

    function rejectRequest(uint256 loanId) external {
        Loan storage l = _getLoan(loanId);
        if (l.lender != msg.sender) revert NotLender();
        _requireStatus(l, LoanStatus.Requested);

        l.status = LoanStatus.Rejected;
        _releaseTool(l.toolId);
        _credit(l.borrower, l.rentalFee + l.deposit);

        emit LoanRejected(loanId);
    }

    /// @notice Owner hands over the tool. The rental fee is released to the owner immediately.
    function approveLoan(uint256 loanId) external {
        Loan storage l = _getLoan(loanId);
        if (l.lender != msg.sender) revert NotLender();
        _requireStatus(l, LoanStatus.Requested);

        l.status = LoanStatus.Active;
        l.startedAt = uint64(block.timestamp);
        l.dueAt = uint64(block.timestamp + uint256(l.durationDays) * 1 days);
        _credit(l.lender, l.rentalFee);

        emit LoanApproved(loanId, l.dueAt);
    }

    function markReturned(uint256 loanId) external {
        Loan storage l = _getLoan(loanId);
        if (l.borrower != msg.sender) revert NotBorrower();
        _requireStatus(l, LoanStatus.Active);

        l.status = LoanStatus.Returned;
        l.returnedAt = uint64(block.timestamp);

        emit ToolMarkedReturned(loanId, l.returnedAt);
    }

    /// @notice Owner confirms the tool is back and optionally claims part of the deposit for damage.
    function confirmReturn(uint256 loanId, uint256 damageCharge) external {
        Loan storage l = _getLoan(loanId);
        if (l.lender != msg.sender) revert NotLender();
        _requireStatus(l, LoanStatus.Returned);

        _settle(l, damageCharge);
    }

    /// @notice If the owner does not respond in time, the borrower can settle with no damage charge.
    function finalizeReturn(uint256 loanId) external {
        Loan storage l = _getLoan(loanId);
        if (l.borrower != msg.sender) revert NotBorrower();
        _requireStatus(l, LoanStatus.Returned);

        uint64 availableAt = uint64(l.returnedAt + RETURN_CONFIRMATION_WINDOW);
        if (block.timestamp < availableAt) revert ConfirmationWindowOpen(availableAt);

        _settle(l, 0);
    }

    /// @notice Owner claims the full deposit when a tool is never returned. The tool is delisted.
    function claimDefault(uint256 loanId) external {
        Loan storage l = _getLoan(loanId);
        if (l.lender != msg.sender) revert NotLender();
        _requireStatus(l, LoanStatus.Active);

        uint64 availableAt = uint64(l.dueAt + DEFAULT_GRACE_PERIOD);
        if (block.timestamp <= availableAt) revert GracePeriodActive(availableAt);

        l.status = LoanStatus.Defaulted;
        Tool storage t = _tools[l.toolId];
        t.currentLoanId = 0;
        t.listed = false;
        _members[l.borrower].defaults++;
        _credit(l.lender, l.deposit);

        emit LoanDefaulted(loanId, l.deposit);
    }

    // ───────────────────────────── Reputation ─────────────────────────────

    /// @notice After a completed loan, each party may rate the other once (1–5).
    function rate(uint256 loanId, uint8 score) external {
        Loan storage l = _getLoan(loanId);
        _requireStatus(l, LoanStatus.Completed);
        if (score == 0 || score > 5) revert InvalidScore();

        address ratee;
        if (msg.sender == l.borrower) {
            if (l.borrowerRated) revert AlreadyRated();
            l.borrowerRated = true;
            ratee = l.lender;
        } else if (msg.sender == l.lender) {
            if (l.lenderRated) revert AlreadyRated();
            l.lenderRated = true;
            ratee = l.borrower;
        } else {
            revert NotParticipant();
        }

        Member storage m = _members[ratee];
        m.ratingCount++;
        m.ratingSum += score;

        emit MemberRated(loanId, msg.sender, ratee, score);
    }

    // ───────────────────────────── Payments ─────────────────────────────

    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        pendingWithdrawals[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawal(msg.sender, amount);
    }

    // ───────────────────────────── Views ─────────────────────────────

    function getMember(address account) external view returns (Member memory) {
        return _members[account];
    }

    function isMember(address account) external view returns (bool) {
        return _members[account].registered;
    }

    function memberCount() external view returns (uint256) {
        return _memberList.length;
    }

    function getMembers() external view returns (address[] memory) {
        return _memberList;
    }

    /// @notice Average rating scaled by 100 (e.g. 450 = 4.50 stars). Returns 0 when unrated.
    function reputationOf(address account) external view returns (uint256) {
        Member storage m = _members[account];
        if (m.ratingCount == 0) return 0;
        return (uint256(m.ratingSum) * 100) / m.ratingCount;
    }

    function getTool(uint256 toolId) external view returns (Tool memory) {
        return _getTool(toolId);
    }

    function getAllTools() external view returns (Tool[] memory list) {
        list = new Tool[](toolCount);
        for (uint256 i = 0; i < toolCount; i++) {
            list[i] = _tools[i + 1];
        }
    }

    function getToolsByOwner(address owner) external view returns (Tool[] memory list) {
        uint256[] storage ids = _toolsByOwner[owner];
        list = new Tool[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            list[i] = _tools[ids[i]];
        }
    }

    function getLoan(uint256 loanId) external view returns (Loan memory) {
        return _getLoan(loanId);
    }

    function getLoansByBorrower(address borrower) external view returns (Loan[] memory) {
        return _loadLoans(_loansByBorrower[borrower]);
    }

    function getLoansByLender(address lender) external view returns (Loan[] memory) {
        return _loadLoans(_loansByLender[lender]);
    }

    /// @notice Late fee that would apply if the tool were returned at `returnTime`.
    function previewLateFee(uint256 loanId, uint256 returnTime) public view returns (uint256) {
        Loan storage l = _getLoan(loanId);
        if (l.dueAt == 0 || returnTime <= l.dueAt) return 0;

        uint256 lateDays = (returnTime - l.dueAt + 1 days - 1) / 1 days;
        uint256 perDay = l.dailyFee > 0
            ? l.dailyFee * LATE_FEE_MULTIPLIER
            : l.deposit / FREE_TOOL_LATE_FEE_DIVISOR;
        uint256 fee = lateDays * perDay;
        return fee > l.deposit ? l.deposit : fee;
    }

    // ───────────────────────────── Internals ─────────────────────────────

    function _settle(Loan storage l, uint256 damageCharge) private {
        uint256 lateFee = previewLateFee(l.id, l.returnedAt);
        uint256 maxDamage = l.deposit - lateFee;
        if (damageCharge > maxDamage) revert ChargesExceedDeposit(maxDamage);

        uint256 refund = maxDamage - damageCharge;
        l.lateFee = lateFee;
        l.damageCharge = damageCharge;
        l.status = LoanStatus.Completed;

        Tool storage t = _tools[l.toolId];
        t.currentLoanId = 0;
        t.timesLent++;

        Member storage borrower = _members[l.borrower];
        borrower.loansCompleted++;
        if (damageCharge > 0) borrower.damageReports++;
        _members[l.lender].toolsLent++;

        _credit(l.lender, lateFee + damageCharge);
        _credit(l.borrower, refund);

        emit LoanCompleted(l.id, lateFee, damageCharge, refund);
    }

    function _credit(address account, uint256 amount) private {
        if (amount > 0) pendingWithdrawals[account] += amount;
    }

    function _releaseTool(uint256 toolId) private {
        _tools[toolId].currentLoanId = 0;
    }

    function _requireStatus(Loan storage l, LoanStatus expected) private view {
        if (l.status != expected) revert InvalidLoanStatus(l.status);
    }

    function _getTool(uint256 toolId) private view returns (Tool storage t) {
        t = _tools[toolId];
        if (t.id == 0) revert ToolNotFound();
    }

    function _getLoan(uint256 loanId) private view returns (Loan storage l) {
        l = _loans[loanId];
        if (l.id == 0) revert LoanNotFound();
    }

    function _loadLoans(uint256[] storage ids) private view returns (Loan[] memory list) {
        list = new Loan[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            list[i] = _loans[ids[i]];
        }
    }
}
