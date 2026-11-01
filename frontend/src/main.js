import { ethers } from "ethers";
import deployment from "./deployment.json";
import "./style.css";

const LOCAL_RPC = "http://127.0.0.1:8545";
const IS_LOCAL = deployment.chainId === 31337;
const DAY = 86400;
const CONFIRM_WINDOW = 3 * DAY;
const GRACE_PERIOD = 7 * DAY;
const CATEGORIES = ["Power Tools", "Hand Tools", "Garden", "Ladders", "Outdoor", "Cleaning", "Other"];
const STATUS = ["Requested", "Active", "Returned", "Completed", "Rejected", "Cancelled", "Defaulted"];

const ERROR_TEXT = {
  NotRegistered: "Join the neighbourhood first (register your profile).",
  AlreadyRegistered: "This account is already registered.",
  EmptyField: "Please fill in all required fields.",
  ToolUnavailable: "Someone else has already requested this tool.",
  ToolNotListed: "This tool is not currently listed.",
  ToolOnLoan: "You can't edit a tool while it's on loan.",
  CannotBorrowOwnTool: "You can't borrow your own tool.",
  InvalidDuration: "Loan length must be between 1 and 30 days.",
  InvalidDeposit: "A deposit greater than zero is required.",
  IncorrectPayment: "Payment amount doesn't match fee + deposit.",
  InvalidLoanStatus: "This loan is no longer in a state that allows that action.",
  ConfirmationWindowOpen: "The owner still has time to inspect the tool.",
  GracePeriodActive: "The borrower's grace period hasn't ended yet.",
  ChargesExceedDeposit: "Damage charge is larger than the remaining deposit.",
  AlreadyRated: "You've already rated this loan.",
  NothingToWithdraw: "Nothing to withdraw.",
};

const state = {
  readProvider: null,
  readContract: null,
  signer: null,
  contract: null,
  account: null,
  mode: null, // "demo" | "metamask"
  demoAccounts: [],
  tab: "browse",
  filter: { q: "", cat: "All" },
  tools: [],
  members: new Map(),
  me: null,
  myLoans: [],
  lendLoans: [],
  events: [],
  pending: 0n,
  now: 0,
  stats: { tools: 0, members: 0, loans: 0, escrow: 0n },
};

// ───────────────────────────── Helpers ─────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const eth = (wei) => {
  const n = Number(ethers.formatEther(wei));
  return n === 0 ? "0" : n < 0.0001 ? "<0.0001" : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
};
const toObj = (r) => r.toObject();
const memberOf = (addr) => state.members.get(addr?.toLowerCase());
const nameOf = (addr) => memberOf(addr)?.name || short(addr);
const isMe = (addr) => state.account && addr?.toLowerCase() === state.account.toLowerCase();
const fmtDate = (ts) =>
  ts ? new Date(Number(ts) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

function relTime(ts) {
  const diff = Number(ts) - state.now;
  const abs = Math.abs(diff);
  const unit = abs >= DAY ? [Math.round(abs / DAY), "day"] : abs >= 3600 ? [Math.round(abs / 3600), "hour"] : [Math.max(1, Math.round(abs / 60)), "minute"];
  const label = `${unit[0]} ${unit[1]}${unit[0] === 1 ? "" : "s"}`;
  return diff >= 0 ? `in ${label}` : `${label} ago`;
}

function stars(rep, count) {
  if (!count) return `<span class="stars muted">new member</span>`;
  const v = Number(rep) / 100;
  const full = Math.round(v);
  return `<span class="stars" title="${v.toFixed(2)} from ${count} rating${count === 1 ? "" : "s"}">${"★".repeat(full)}${"☆".repeat(5 - full)} <em>${v.toFixed(1)}</em></span>`;
}

const iface = new ethers.Interface(deployment.abi);

function errorMessage(err) {
  let name = err?.revert?.name;
  if (!name && typeof err?.data === "string") {
    try {
      name = iface.parseError(err.data)?.name;
    } catch {}
  }
  if (name && ERROR_TEXT[name]) return ERROR_TEXT[name];
  if (err?.code === "ACTION_REJECTED") return "Transaction rejected in wallet.";
  return err?.shortMessage || err?.reason || err?.message || "Something went wrong.";
}

// ───────────────────────────── Toasts & modals ─────────────────────────────

function toast(text, kind = "pending") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="dot"></span><span class="msg">${text}</span>`;
  $("#toasts").prepend(el);
  const api = {
    update(t, k = kind) {
      el.className = `toast ${k}`;
      $(".msg", el).innerHTML = t;
      if (k !== "pending") setTimeout(() => el.classList.add("out"), 4500), setTimeout(() => el.remove(), 5000);
      return api;
    },
  };
  if (kind !== "pending") api.update(text, kind);
  return api;
}

function openModal(html, onMount) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="backdrop" data-action="close-modal"></div><div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  root.classList.add("open");
  onMount?.(root);
  $("input, select, button.primary", root)?.focus();
}

function closeModal() {
  const root = $("#modal-root");
  root.classList.remove("open");
  root.innerHTML = "";
}

async function send(label, fn) {
  if (!state.contract) return toast("Connect a wallet first.", "error");
  const t = toast(`${label}: confirm in wallet…`);
  try {
    const tx = await fn(state.contract);
    t.update(`${label}: mining <code>${short(tx.hash)}</code>`);
    const receipt = await tx.wait();
    t.update(`${label} confirmed in block #${receipt.blockNumber}`, "ok");
    closeModal();
    await refresh();
    return true;
  } catch (err) {
    console.error(err);
    t.update(`${label} failed: ${esc(errorMessage(err))}`, "error");
    return false;
  }
}

// ───────────────────────────── Chain access ─────────────────────────────

function initReadProvider() {
  if (!deployment.address) return;
  if (IS_LOCAL) state.readProvider = new ethers.JsonRpcProvider(LOCAL_RPC, undefined, { pollingInterval: 1500 });
  else if (window.ethereum) state.readProvider = new ethers.BrowserProvider(window.ethereum);
  if (state.readProvider) state.readContract = new ethers.Contract(deployment.address, deployment.abi, state.readProvider);
}

async function loadDemoAccounts() {
  if (!IS_LOCAL || !state.readProvider) return;
  try {
    const signers = await state.readProvider.listAccounts();
    state.demoAccounts = signers.slice(0, 10).map((s) => s.address);
  } catch {
    state.demoAccounts = [];
  }
}

async function useDemoAccount(index) {
  state.signer = await state.readProvider.getSigner(Number(index));
  state.account = await state.signer.getAddress();
  state.mode = "demo";
  state.contract = new ethers.Contract(deployment.address, deployment.abi, state.signer);
  await refresh();
}

async function connectMetaMask() {
  if (!window.ethereum) return toast("MetaMask not detected. Install it or use a demo account.", "error");
  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const { chainId } = await provider.getNetwork();
    if (Number(chainId) !== deployment.chainId) {
      try {
        await provider.send("wallet_switchEthereumChain", [{ chainId: ethers.toQuantity(deployment.chainId) }]);
      } catch {
        return toast(`Switch MetaMask to chain ${deployment.chainId} (${deployment.network}).`, "error");
      }
    }
    const fresh = new ethers.BrowserProvider(window.ethereum);
    state.signer = await fresh.getSigner();
    state.account = await state.signer.getAddress();
    state.mode = "metamask";
    state.contract = new ethers.Contract(deployment.address, deployment.abi, state.signer);
    window.ethereum.on?.("accountsChanged", () => connectMetaMask());
    window.ethereum.on?.("chainChanged", () => location.reload());
    await refresh();
  } catch (err) {
    toast(esc(errorMessage(err)), "error");
  }
}

let refreshing = null;
async function refresh() {
  if (!state.readContract) return render();
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const c = state.readContract;
    try {
      const [tools, addrs, loanCount, escrow, block] = await Promise.all([
        c.getAllTools(),
        c.getMembers(),
        c.loanCount(),
        state.readProvider.getBalance(deployment.address),
        state.readProvider.getBlock("latest"),
      ]);
      state.now = block.timestamp;
      state.tools = tools.map(toObj);

      const profiles = await Promise.all(addrs.map((a) => Promise.all([c.getMember(a), c.reputationOf(a)])));
      state.members = new Map(addrs.map((a, i) => [a.toLowerCase(), { address: a, ...toObj(profiles[i][0]), rep: profiles[i][1] }]));
      state.stats = { tools: tools.length, members: addrs.length, loans: Number(loanCount), escrow };

      if (state.account) {
        const [mine, lend, pending] = await Promise.all([
          c.getLoansByBorrower(state.account),
          c.getLoansByLender(state.account),
          c.pendingWithdrawals(state.account),
        ]);
        state.me = memberOf(state.account) || null;
        state.myLoans = mine.map(toObj).reverse();
        state.lendLoans = lend.map(toObj).reverse();
        state.pending = pending;
      }

      const logs = await c.queryFilter("*", deployment.deployBlock || 0);
      state.events = logs.filter((l) => l.eventName).slice(-60).reverse();
    } catch (err) {
      console.error(err);
      toast(`Could not reach the blockchain: ${esc(errorMessage(err))}`, "error");
    }
    render();
  })().finally(() => (refreshing = null));
  return refreshing;
}

// ───────────────────────────── Rendering ─────────────────────────────

function render() {
  renderWallet();
  renderStats();
  renderTabs();
  renderFooter();

  const app = $("#app");
  if (!deployment.address) {
    app.innerHTML = notDeployed();
    return;
  }
  const views = { browse: viewBrowse, shed: viewShed, borrowing: viewBorrowing, ledger: viewLedger, profile: viewProfile };
  app.innerHTML = (views[state.tab] || viewBrowse)();
}

function renderWallet() {
  const el = $("#wallet");
  const demoPicker =
    IS_LOCAL && state.demoAccounts.length
      ? `<label class="picker"><span>Demo account</span>
          <select data-action="demo-account">
            <option value="" ${state.mode !== "demo" ? "selected" : ""} disabled>Choose…</option>
            ${state.demoAccounts
              .map((a, i) => `<option value="${i}" ${state.mode === "demo" && isMe(a) ? "selected" : ""}>#${i} ${esc(memberOf(a)?.name || short(a))}</option>`)
              .join("")}
          </select></label>`
      : "";

  const who = state.account
    ? `<div class="whoami">
        <span class="addr" title="${state.account}">${esc(state.me?.name || "Unregistered")} · <code>${short(state.account)}</code></span>
        <button class="btn ghost small" data-action="tab" data-tab="profile">
          Balance <strong>${eth(state.pending)} ETH</strong>
        </button>
      </div>`
    : "";

  el.innerHTML = `${demoPicker}${who}${
    state.mode === "metamask" ? "" : `<button class="btn primary" data-action="connect">${state.account ? "Use MetaMask" : "Connect MetaMask"}</button>`
  }`;
}

function renderStats() {
  const s = state.stats;
  const available = state.tools.filter((t) => t.listed && t.currentLoanId === 0n).length;
  $("#stats").innerHTML = [
    ["Tools on the pegboard", s.tools],
    ["Available now", available],
    ["Neighbours", s.members],
    ["Loans recorded", s.loans],
    ["ETH held in escrow", eth(s.escrow)],
  ]
    .map(([k, v], i) => `<div class="stat" style="--i:${i}"><b>${v}</b><span>${k}</span></div>`)
    .join("");
}

function renderTabs() {
  const needsAction =
    state.lendLoans.filter((l) => l.status === 0n || l.status === 2n).length +
    state.myLoans.filter((l) => l.status === 1n && state.now > Number(l.dueAt)).length;
  const tabs = [
    ["browse", "Browse"],
    ["shed", "My Shed", needsAction],
    ["borrowing", "Borrowing"],
    ["ledger", "Ledger"],
    ["profile", "Profile & Wallet"],
  ];
  $("#tabs").innerHTML = tabs
    .map(
      ([id, label, badge]) =>
        `<button class="tab ${state.tab === id ? "active" : ""}" data-action="tab" data-tab="${id}">${label}${badge ? `<i>${badge}</i>` : ""}</button>`
    )
    .join("");
}

function renderFooter() {
  $("#contract-info").innerHTML = deployment.address
    ? `Contract <code>${deployment.address}</code> · ${esc(deployment.network)} (chain ${deployment.chainId}) · chain time ${fmtDate(state.now)}`
    : "Contract not deployed";
  $("#dev-tools").innerHTML =
    IS_LOCAL && deployment.address
      ? `<button class="btn ghost small" data-action="time-travel" data-days="1">Fast-forward 1 day</button>
         <button class="btn ghost small" data-action="time-travel" data-days="7">+7 days</button>`
      : "";
}

function notDeployed() {
  return `<div class="empty big">
    <h2>No contract deployed yet</h2>
    <p>Start a local chain and deploy the contract, then reload this page:</p>
    <pre>npm run node          # terminal 1
npm run deploy:local  # terminal 2
npm run seed:local    # optional demo data</pre>
  </div>`;
}

function registerCallout() {
  if (!state.account) return `<div class="callout">Pick a demo account or connect MetaMask to borrow and lend.</div>`;
  if (state.me) return "";
  return `<form class="callout register" data-form="register">
      <div><strong>Join the neighbourhood.</strong> Register once to list and borrow tools.</div>
      <input name="name" placeholder="Your name" required maxlength="40" />
      <input name="neighbourhood" placeholder="Street / block" required maxlength="40" />
      <button class="btn primary">Register on-chain</button>
    </form>`;
}

function toolStatus(t) {
  if (!t.listed) return ["Unlisted", "off"];
  if (t.currentLoanId === 0n) return ["Available", "ok"];
  return ["Reserved", "busy"];
}

function toolTag(t, i, { owned = false } = {}) {
  const [label, cls] = toolStatus(t);
  const owner = memberOf(t.owner);
  const canBorrow = state.me && !isMe(t.owner) && cls === "ok";
  return `<article class="tag ${cls}" style="--i:${i}">
      <div class="tag-head"><span class="cat">${esc(t.category)}</span><span class="badge ${cls}">${label}</span></div>
      <h3>${esc(t.name)}</h3>
      <p class="desc">${esc(t.description) || "<span class='muted'>No description</span>"}</p>
      <dl class="price">
        <div><dt>Per day</dt><dd>${t.dailyFee === 0n ? "Free" : `${eth(t.dailyFee)} ETH`}</dd></div>
        <div><dt>Deposit</dt><dd>${eth(t.deposit)} ETH</dd></div>
      </dl>
      <footer>
        <div class="owner">
          <span>${isMe(t.owner) ? "Yours" : esc(owner?.name || short(t.owner))}${owner ? ` · ${esc(owner.neighbourhood)}` : ""}</span>
          ${stars(owner?.rep, Number(owner?.ratingCount || 0))}
        </div>
        ${
          owned
            ? `<button class="btn ghost small" data-action="edit-tool" data-id="${t.id}" ${t.currentLoanId !== 0n ? "disabled title='On loan'" : ""}>Edit</button>`
            : canBorrow
              ? `<button class="btn primary small" data-action="borrow" data-id="${t.id}">Borrow</button>`
              : ""
        }
      </footer>
      <span class="lent">lent ${t.timesLent}×</span>
    </article>`;
}

function viewBrowse() {
  const { q, cat } = state.filter;
  const cats = ["All", ...new Set([...CATEGORIES, ...state.tools.map((t) => t.category)])];
  const list = state.tools.filter(
    (t) =>
      t.listed &&
      (cat === "All" || t.category === cat) &&
      (!q || `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(q.toLowerCase()))
  );

  return `${registerCallout()}
    <div class="toolbar">
      <input class="search" type="search" placeholder="Search drills, ladders, tents…" value="${esc(q)}" data-action="search" />
      <div class="chips">${cats
        .map((c) => `<button class="chip ${c === cat ? "on" : ""}" data-action="category" data-cat="${esc(c)}">${esc(c)}</button>`)
        .join("")}</div>
    </div>
    <div class="pegboard">${
      list.length ? list.map((t, i) => toolTag(t, i)).join("") : `<div class="empty">Nothing on the pegboard matches.</div>`
    }</div>`;
}

function viewShed() {
  if (!state.me) return registerCallout() || "";
  const mine = state.tools.filter((t) => isMe(t.owner));
  const incoming = state.lendLoans.filter((l) => l.status <= 2n);
  const past = state.lendLoans.filter((l) => l.status > 2n);

  return `<div class="split">
    <section>
      <h2 class="section-title">Requests & active loans <small>${incoming.length}</small></h2>
      ${incoming.length ? incoming.map((l) => loanCard(l, "lender")).join("") : `<div class="empty">No open requests for your tools.</div>`}
      <h2 class="section-title">My tools <small>${mine.length}</small></h2>
      <div class="pegboard compact">${mine.map((t, i) => toolTag(t, i, { owned: true })).join("") || `<div class="empty">You haven't listed anything yet.</div>`}</div>
      ${past.length ? `<h2 class="section-title">Lending history</h2>${past.map((l) => loanCard(l, "lender")).join("")}` : ""}
    </section>
    <aside>
      <form class="panel" data-form="list-tool">
        <h2>List a tool</h2>
        <label>Name<input name="name" required maxlength="60" placeholder="e.g. Cordless drill" /></label>
        <label>Category<select name="category">${CATEGORIES.map((c) => `<option>${c}</option>`).join("")}</select></label>
        <label>Description<textarea name="description" rows="3" maxlength="240" placeholder="Condition, accessories, pickup notes"></textarea></label>
        <div class="row">
          <label>Daily fee (ETH)<input name="dailyFee" type="number" min="0" step="0.0001" value="0.002" required /></label>
          <label>Deposit (ETH)<input name="deposit" type="number" min="0.0001" step="0.0001" value="0.05" required /></label>
        </div>
        <p class="hint">The deposit is locked in the contract and refunded when the tool comes back. Set the fee to 0 to lend for free.</p>
        <button class="btn primary wide">Hang it on the pegboard</button>
      </form>
    </aside>
  </div>`;
}

function viewBorrowing() {
  if (!state.me) return registerCallout() || "";
  const open = state.myLoans.filter((l) => l.status <= 2n);
  const past = state.myLoans.filter((l) => l.status > 2n);
  return `<h2 class="section-title">Current <small>${open.length}</small></h2>
    ${open.length ? open.map((l) => loanCard(l, "borrower")).join("") : `<div class="empty">You're not borrowing anything. <a href="#" data-action="tab" data-tab="browse">Browse the pegboard →</a></div>`}
    ${past.length ? `<h2 class="section-title">History</h2>${past.map((l) => loanCard(l, "borrower")).join("")}` : ""}`;
}

function loanCard(l, role) {
  const tool = state.tools.find((t) => t.id === l.toolId);
  const status = STATUS[Number(l.status)];
  const other = role === "lender" ? l.borrower : l.lender;
  const otherM = memberOf(other);
  const overdue = l.status === 1n && state.now > Number(l.dueAt);
  const actions = [];

  if (role === "lender") {
    if (l.status === 0n) {
      actions.push(`<button class="btn primary small" data-action="approve" data-id="${l.id}">Approve & hand over</button>`);
      actions.push(`<button class="btn ghost small" data-action="reject" data-id="${l.id}">Reject</button>`);
    }
    if (l.status === 2n) actions.push(`<button class="btn primary small" data-action="confirm-return" data-id="${l.id}">Inspect & confirm return</button>`);
    if (l.status === 1n && state.now > Number(l.dueAt) + GRACE_PERIOD)
      actions.push(`<button class="btn danger small" data-action="claim-default" data-id="${l.id}">Claim deposit (not returned)</button>`);
    if (l.status === 3n && !l.lenderRated) actions.push(rateButtons(l.id, "borrower"));
  } else {
    if (l.status === 0n) actions.push(`<button class="btn ghost small" data-action="cancel" data-id="${l.id}">Cancel request</button>`);
    if (l.status === 1n) actions.push(`<button class="btn primary small" data-action="return" data-id="${l.id}">I've returned it</button>`);
    if (l.status === 2n && state.now >= Number(l.returnedAt) + CONFIRM_WINDOW)
      actions.push(`<button class="btn primary small" data-action="finalize" data-id="${l.id}">Reclaim deposit</button>`);
    if (l.status === 3n && !l.borrowerRated) actions.push(rateButtons(l.id, "owner"));
  }

  const timeline = [
    ["Requested", l.requestedAt],
    ["Handed over", l.startedAt],
    ["Due", l.dueAt],
    ["Returned", l.returnedAt],
  ]
    .filter(([, ts]) => ts > 0n)
    .map(([k, ts]) => `<li><span>${k}</span><time>${fmtDate(ts)}</time></li>`)
    .join("");

  let note = "";
  if (l.status === 0n) note = role === "lender" ? "Waiting for your decision. Funds are already in escrow." : "Waiting for the owner to approve.";
  if (l.status === 1n) note = overdue ? `<b class="warn">Overdue</b> by ${relTime(l.dueAt).replace(" ago", "")} — late fees are accruing.` : `Due back ${relTime(l.dueAt)}.`;
  if (l.status === 2n)
    note =
      role === "lender"
        ? `Borrower says it's back. Inspect it — you can confirm until ${fmtDate(Number(l.returnedAt) + CONFIRM_WINDOW)}.`
        : `Waiting for the owner to confirm. If they don't by ${fmtDate(Number(l.returnedAt) + CONFIRM_WINDOW)}, you can reclaim the deposit yourself.`;
  if (l.status === 3n) note = `Settled — late fee ${eth(l.lateFee)} ETH, damage ${eth(l.damageCharge)} ETH, refund ${eth(l.deposit - l.lateFee - l.damageCharge)} ETH.`;
  if (l.status === 6n) note = "Tool was not returned. Deposit transferred to the owner.";

  return `<article class="loan s-${status.toLowerCase()} ${overdue ? "overdue" : ""}">
      <header>
        <span class="ticket">#${l.id}</span>
        <h3>${esc(tool?.name || `Tool #${l.toolId}`)}</h3>
        <span class="badge s-${status.toLowerCase()}">${overdue ? "Overdue" : status}</span>
      </header>
      <div class="loan-body">
        <div>
          <p class="who">${role === "lender" ? "Borrower" : "Owner"}: <strong>${esc(otherM?.name || short(other))}</strong> ${stars(otherM?.rep, Number(otherM?.ratingCount || 0))}</p>
          <p class="note">${note}</p>
          <div class="actions">${actions.join("")}</div>
        </div>
        <dl class="money">
          <div><dt>${l.durationDays} day${l.durationDays === 1n ? "" : "s"} rental</dt><dd>${eth(l.rentalFee)}</dd></div>
          <div><dt>Deposit</dt><dd>${eth(l.deposit)}</dd></div>
          <div class="total"><dt>Locked</dt><dd>${eth(l.rentalFee + l.deposit)} ETH</dd></div>
        </dl>
        <ol class="timeline">${timeline}</ol>
      </div>
    </article>`;
}

function rateButtons(loanId, whom) {
  return `<span class="rate">Rate the ${whom}: ${[1, 2, 3, 4, 5]
    .map((n) => `<button class="star" data-action="rate" data-id="${loanId}" data-score="${n}" title="${n} star${n > 1 ? "s" : ""}">★</button>`)
    .join("")}</span>`;
}

function viewLedger() {
  if (!state.events.length) return `<div class="empty">No on-chain activity yet.</div>`;
  const describe = (e) => {
    const a = e.args;
    const tool = (id) => esc(state.tools.find((t) => t.id === id)?.name || `tool #${id}`);
    switch (e.eventName) {
      case "MemberRegistered": return `<b>${esc(a.name)}</b> joined from ${esc(a.neighbourhood)}`;
      case "ProfileUpdated": return `<b>${esc(a.name)}</b> updated their profile`;
      case "ToolListed": return `<b>${esc(nameOf(a.owner))}</b> listed ${esc(a.name)} · ${eth(a.dailyFee)} ETH/day`;
      case "ToolUpdated": return `${tool(a.toolId)} updated${a.listed ? "" : " (unlisted)"}`;
      case "LoanRequested": return `<b>${esc(nameOf(a.borrower))}</b> requested ${tool(a.toolId)} for ${a.durationDays} day(s), locking ${eth(a.amountLocked)} ETH`;
      case "LoanCancelled": return `Loan #${a.loanId} cancelled by borrower`;
      case "LoanRejected": return `Loan #${a.loanId} rejected by owner`;
      case "LoanApproved": return `Loan #${a.loanId} approved, due ${fmtDate(a.dueAt)}`;
      case "ToolMarkedReturned": return `Loan #${a.loanId}: tool marked as returned`;
      case "LoanCompleted": return `Loan #${a.loanId} settled · refund ${eth(a.depositRefund)} ETH, late ${eth(a.lateFee)}, damage ${eth(a.damageCharge)}`;
      case "LoanDefaulted": return `Loan #${a.loanId} defaulted · ${eth(a.depositClaimed)} ETH deposit to owner`;
      case "MemberRated": return `<b>${esc(nameOf(a.rater))}</b> rated <b>${esc(nameOf(a.ratee))}</b> ${"★".repeat(Number(a.score))}`;
      case "Withdrawal": return `<b>${esc(nameOf(a.member))}</b> withdrew ${eth(a.amount)} ETH`;
      default: return e.eventName;
    }
  };
  return `<p class="lede">Every action is an immutable event on the blockchain. This feed is read directly from contract logs.</p>
    <ol class="ledger">${state.events
      .map(
        (e) => `<li>
          <span class="blk">#${e.blockNumber}</span>
          <span class="evt">${e.eventName}</span>
          <span class="what">${describe(e)}</span>
          <code class="tx" title="${e.transactionHash}">${short(e.transactionHash)}</code>
        </li>`
      )
      .join("")}</ol>`;
}

function viewProfile() {
  if (!state.account) return registerCallout();
  const m = state.me;
  return `<div class="split">
    <section class="panel">
      <h2>${m ? esc(m.name) : "Not registered"}</h2>
      ${
        m
          ? `<p class="muted">${esc(m.neighbourhood)} · member since ${fmtDate(m.joinedAt)}</p>
             <div class="profile-stats">
               <div><b>${stars(m.rep, Number(m.ratingCount))}</b><span>${m.ratingCount} rating(s)</span></div>
               <div><b>${m.loansCompleted}</b><span>Loans completed</span></div>
               <div><b>${m.toolsLent}</b><span>Tools lent out</span></div>
               <div><b>${m.damageReports}</b><span>Damage reports</span></div>
               <div><b>${m.defaults}</b><span>Defaults</span></div>
             </div>
             <form data-form="profile" class="row">
               <label>Name<input name="name" value="${esc(m.name)}" required maxlength="40" /></label>
               <label>Street / block<input name="neighbourhood" value="${esc(m.neighbourhood)}" required maxlength="40" /></label>
               <button class="btn ghost">Update</button>
             </form>`
          : registerCallout()
      }
      <p class="mono muted">${state.account}</p>
    </section>
    <aside class="panel wallet-panel">
      <h2>Withdrawable balance</h2>
      <p class="big-number">${eth(state.pending)} <small>ETH</small></p>
      <p class="hint">Refunds, rental income and late/damage fees are credited here. The contract uses the pull-payment pattern, so funds move only when you withdraw.</p>
      <button class="btn primary wide" data-action="withdraw" ${state.pending === 0n ? "disabled" : ""}>Withdraw to wallet</button>
    </aside>
  </div>`;
}

// ───────────────────────────── Modals ─────────────────────────────

function borrowModal(toolId) {
  const t = state.tools.find((x) => x.id === BigInt(toolId));
  if (!t) return;
  openModal(
    `<h2>Borrow ${esc(t.name)}</h2>
     <p class="muted">from ${esc(nameOf(t.owner))}</p>
     <label>How many days?<input type="range" min="1" max="30" value="3" data-bind="days" /></label>
     <output class="days-out"></output>
     <dl class="money receipt"></dl>
     <p class="hint">Fee + deposit are locked in the contract now. The fee goes to the owner on approval; the deposit comes back when you return the tool (minus any late fees at ${t.dailyFee > 0n ? "2× the daily fee" : "10% of the deposit"} per overdue day).</p>
     <div class="modal-actions">
       <button class="btn ghost" data-action="close-modal">Cancel</button>
       <button class="btn primary" data-action="borrow-confirm" data-id="${t.id}">Lock funds & request</button>
     </div>`,
    (root) => {
      const range = $("[data-bind=days]", root);
      const update = () => {
        const d = BigInt(range.value);
        const fee = t.dailyFee * d;
        $(".days-out", root).textContent = `${d} day${d === 1n ? "" : "s"}`;
        $(".receipt", root).innerHTML = `<div><dt>Rental</dt><dd>${eth(fee)} ETH</dd></div>
          <div><dt>Refundable deposit</dt><dd>${eth(t.deposit)} ETH</dd></div>
          <div class="total"><dt>Total locked</dt><dd>${eth(fee + t.deposit)} ETH</dd></div>`;
      };
      range.addEventListener("input", update);
      update();
    }
  );
}

async function confirmReturnModal(loanId) {
  const l = state.lendLoans.find((x) => x.id === BigInt(loanId));
  const lateFee = await state.readContract.previewLateFee(l.id, l.returnedAt);
  const maxDamage = l.deposit - lateFee;
  openModal(
    `<h2>Confirm return · loan #${l.id}</h2>
     <dl class="money receipt">
       <div><dt>Deposit held</dt><dd>${eth(l.deposit)} ETH</dd></div>
       <div><dt>Late fee (automatic)</dt><dd>${eth(lateFee)} ETH</dd></div>
     </dl>
     <label>Damage charge (ETH, optional)
       <input type="number" min="0" step="0.0001" max="${ethers.formatEther(maxDamage)}" value="0" data-bind="damage" />
     </label>
     <p class="hint">Max ${eth(maxDamage)} ETH. Leave at 0 if the tool came back in good shape. Damage charges are recorded on the borrower's profile.</p>
     <div class="modal-actions">
       <button class="btn ghost" data-action="close-modal">Cancel</button>
       <button class="btn primary" data-action="confirm-return-submit" data-id="${l.id}">Settle loan</button>
     </div>`
  );
}

function editToolModal(toolId) {
  const t = state.tools.find((x) => x.id === BigInt(toolId));
  openModal(
    `<h2>Edit ${esc(t.name)}</h2>
     <form data-form="edit-tool" data-id="${t.id}">
       <div class="row">
         <label>Daily fee (ETH)<input name="dailyFee" type="number" min="0" step="0.0001" value="${ethers.formatEther(t.dailyFee)}" /></label>
         <label>Deposit (ETH)<input name="deposit" type="number" min="0.0001" step="0.0001" value="${ethers.formatEther(t.deposit)}" /></label>
       </div>
       <label class="check"><input type="checkbox" name="listed" ${t.listed ? "checked" : ""} /> Listed on the pegboard</label>
       <div class="modal-actions">
         <button type="button" class="btn ghost" data-action="close-modal">Cancel</button>
         <button class="btn primary">Save</button>
       </div>
     </form>`
  );
}

// ───────────────────────────── Event wiring ─────────────────────────────

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.tagName === "SELECT" || el.tagName === "INPUT") return;
  const { action, id } = el.dataset;
  if (el.tagName === "A") e.preventDefault();

  switch (action) {
    case "tab":
      state.tab = el.dataset.tab;
      return render();
    case "category":
      state.filter.cat = el.dataset.cat;
      return render();
    case "connect":
      return connectMetaMask();
    case "close-modal":
      return closeModal();
    case "borrow":
      return borrowModal(id);
    case "borrow-confirm": {
      const t = state.tools.find((x) => x.id === BigInt(id));
      const days = BigInt($("[data-bind=days]").value);
      return send("Borrow request", (c) => c.requestLoan(t.id, days, { value: t.dailyFee * days + t.deposit }));
    }
    case "cancel":
      return send("Cancel request", (c) => c.cancelRequest(id));
    case "reject":
      return send("Reject request", (c) => c.rejectRequest(id));
    case "approve":
      return send("Approve loan", (c) => c.approveLoan(id));
    case "return":
      return send("Mark returned", (c) => c.markReturned(id));
    case "confirm-return":
      return confirmReturnModal(id);
    case "confirm-return-submit": {
      const damage = ethers.parseEther($("[data-bind=damage]").value || "0");
      return send("Confirm return", (c) => c.confirmReturn(id, damage));
    }
    case "finalize":
      return send("Reclaim deposit", (c) => c.finalizeReturn(id));
    case "claim-default":
      return send("Claim deposit", (c) => c.claimDefault(id));
    case "rate":
      return send("Rating", (c) => c.rate(id, Number(el.dataset.score)));
    case "withdraw":
      return send("Withdraw", (c) => c.withdraw());
    case "edit-tool":
      return editToolModal(id);
    case "time-travel": {
      const days = Number(el.dataset.days);
      await state.readProvider.send("evm_increaseTime", [days * DAY]);
      await state.readProvider.send("evm_mine", []);
      toast(`Chain clock moved forward ${days} day${days > 1 ? "s" : ""}.`, "ok");
      return refresh();
    }
  }
});

document.addEventListener("change", (e) => {
  if (e.target.matches("[data-action=demo-account]")) useDemoAccount(e.target.value);
});

document.addEventListener("input", (e) => {
  if (e.target.matches("[data-action=search]")) {
    state.filter.q = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const input = $("[data-action=search]");
    input.focus();
    input.setSelectionRange(pos, pos);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

document.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));

  switch (form.dataset.form) {
    case "register":
      return send("Register", (c) => c.registerMember(f.name.trim(), f.neighbourhood.trim()));
    case "profile":
      return send("Update profile", (c) => c.updateProfile(f.name.trim(), f.neighbourhood.trim()));
    case "list-tool":
      return send("List tool", (c) =>
        c.listTool(f.name.trim(), f.category, f.description.trim(), ethers.parseEther(f.dailyFee || "0"), ethers.parseEther(f.deposit))
      );
    case "edit-tool":
      return send("Update tool", (c) =>
        c.updateTool(form.dataset.id, ethers.parseEther(f.dailyFee || "0"), ethers.parseEther(f.deposit), f.listed === "on")
      );
  }
});

// ───────────────────────────── Boot ─────────────────────────────

(async function boot() {
  initReadProvider();
  render();
  if (!state.readProvider) return;
  await loadDemoAccounts();
  await refresh();

  let pendingRefresh;
  state.readProvider.on("block", () => {
    if ($("#modal-root").classList.contains("open") || document.activeElement?.matches("input, textarea, select")) return;
    clearTimeout(pendingRefresh);
    pendingRefresh = setTimeout(refresh, 300);
  });
})();
