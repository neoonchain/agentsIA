// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Where accepted orders go. On Elysium this will be an adapter to the ElysiumCoreWriter predeploy, which places
/// orders on the owner's own HyperCore account through a trade-only agent (no withdrawals). Its interface is not
/// published yet (it ships in an ArbOS upgrade about four weeks after mainnet), so until then the router is unset and
/// the Guard runs in paper mode: every order is checked and recorded on-chain, and nothing is sent.
interface IOrderRouter {
    function route(uint64 nonce, bytes32 market, bool isBuy, uint256 sizeUsd, uint256 limitPx, bool reduceOnly) external;
}

/// @title KairosGuard
/// @notice Brake as a contract. The Kairos agent proposes; this contract checks every order against limits that only the
/// owner can change, and is the only path an order can take. Every decision, accepted order and rejection is an event,
/// so the record can be checked by anyone.
/// @dev Amounts in USD with 6 decimals. Prices with 8 decimals. Unaudited: testnet only until audited.
contract KairosGuard {
    // ---------- roles ----------
    address public owner; // the user: limits, agent, router, markets, unpause
    address public agent; // the Kairos app's key: proposes orders, logs decisions, can pause, nothing else
    IOrderRouter public router; // address(0) = paper mode

    // ---------- limits (owner only) ----------
    struct Limits {
        uint16 maxRiskBps; // risk per order (size x distance to stop) as basis points of equity, e.g. 300 = 3%
        uint16 maxDailyLossBps; // loss since the start of the UTC day, e.g. 600 = 6%
        uint16 maxDrawdownBps; // drop from the equity peak, e.g. 2500 = 25%; hitting it pauses the Guard
        uint8 maxOpenPositions;
        uint128 maxOrderUsd; // hard cap on a single order's size
    }
    Limits public limits;
    mapping(bytes32 => bool) public allowedMarket; // e.g. keccak256("BTC-PERP"), keccak256("GOLD-XYZ")
    bool public paused;

    // ---------- accounting ----------
    int256 public equityUsd;
    int256 public peakUsd;
    int256 public dayStartUsd;
    uint64 public day; // current UTC day number
    uint8 public openPositions;
    mapping(bytes32 => bool) public isOpen;
    mapping(uint64 => bool) public usedNonce;
    mapping(uint64 => bool) public settled;
    mapping(uint64 => bytes32) public marketOf;

    // ---------- events: the public record ----------
    event Decision(bytes32 indexed decisionHash, string summary); // hash of the full decision note kept in the vault
    event OrderAccepted(uint64 indexed nonce, bytes32 indexed market, bool isBuy, uint256 sizeUsd, uint256 limitPx, uint256 stopPx, bool reduceOnly, bytes32 decisionHash, bool paper);
    event OrderRejected(uint64 indexed nonce, bytes32 indexed market, string reason, bytes32 decisionHash);
    event Settled(uint64 indexed nonce, bytes32 indexed market, int256 realizedPnlUsd, bool closed, int256 equityUsd);
    event Paused(address by, string reason);
    event Unpaused();
    event LimitsSet(Limits limits);
    event MarketSet(bytes32 indexed market, bool allowed);
    event AgentSet(address agent);
    event RouterSet(address router);

    error NotOwner();
    error NotAgent();
    error NotSettler();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyAgent() { if (msg.sender != agent) revert NotAgent(); _; }

    constructor(address agent_, Limits memory limits_, int256 startEquityUsd) {
        owner = msg.sender;
        agent = agent_;
        limits = limits_;
        equityUsd = startEquityUsd;
        peakUsd = startEquityUsd;
        dayStartUsd = startEquityUsd;
        day = uint64(block.timestamp / 1 days);
        emit AgentSet(agent_);
        emit LimitsSet(limits_);
    }

    // ---------- owner ----------
    function setLimits(Limits calldata l) external onlyOwner { limits = l; emit LimitsSet(l); }
    function setAgent(address a) external onlyOwner { agent = a; emit AgentSet(a); }
    function setRouter(address r) external onlyOwner { router = IOrderRouter(r); emit RouterSet(r); }
    function setMarket(bytes32 market, bool allowed) external onlyOwner { allowedMarket[market] = allowed; emit MarketSet(market, allowed); }
    function unpause() external onlyOwner { paused = false; peakUsd = equityUsd; emit Unpaused(); } // a fresh peak after you decide to resume
    function transferOwnership(address o) external onlyOwner { owner = o; }

    // ---------- agent or owner: stop everything ----------
    function pause(string calldata reason) external {
        if (msg.sender != owner && msg.sender != agent) revert NotAgent();
        paused = true;
        emit Paused(msg.sender, reason);
    }

    // ---------- agent ----------
    /// @notice Record a decision (holds included). decisionHash = keccak256 of the decision note the app keeps.
    function logDecision(bytes32 decisionHash, string calldata summary) external onlyAgent { emit Decision(decisionHash, summary); }

    /// @notice Propose an order. Returns true and routes it if every limit holds; otherwise records why and returns false.
    function submitOrder(uint64 nonce, bytes32 market, bool isBuy, uint256 sizeUsd, uint256 limitPx, uint256 stopPx, bool reduceOnly, bytes32 decisionHash)
        external onlyAgent returns (bool)
    {
        _rollDay();
        string memory why = _check(nonce, market, isBuy, sizeUsd, limitPx, stopPx, reduceOnly);
        usedNonce[nonce] = true;
        if (bytes(why).length != 0) { emit OrderRejected(nonce, market, why, decisionHash); return false; }
        marketOf[nonce] = market;
        if (!reduceOnly) { isOpen[market] = true; openPositions++; }
        bool paper = address(router) == address(0);
        emit OrderAccepted(nonce, market, isBuy, sizeUsd, limitPx, stopPx, reduceOnly, decisionHash, paper);
        if (!paper) router.route(nonce, market, isBuy, sizeUsd, limitPx, reduceOnly);
        return true;
    }

    /// @notice The result of an accepted order. Called by the router (its on-chain callback) once Elysium's write path
    /// exists; in paper mode by the agent. Idempotent: a nonce settles once.
    function settle(uint64 nonce, int256 realizedPnlUsd, bool closed) external {
        if (msg.sender != address(router) && !(address(router) == address(0) && msg.sender == agent)) revert NotSettler();
        if (marketOf[nonce] == bytes32(0) || settled[nonce]) return; // only accepted orders settle, once
        settled[nonce] = true;
        _rollDay();
        bytes32 market = marketOf[nonce];
        equityUsd += realizedPnlUsd;
        if (equityUsd > peakUsd) peakUsd = equityUsd;
        if (closed && isOpen[market]) { isOpen[market] = false; openPositions--; }
        emit Settled(nonce, market, realizedPnlUsd, closed, equityUsd);
        if (_drawdownBps() >= limits.maxDrawdownBps && !paused) { paused = true; emit Paused(address(this), "max drawdown reached"); }
    }

    // ---------- views ----------
    function drawdownBps() external view returns (uint256) { return _drawdownBps(); }
    function marketId(string calldata name) external pure returns (bytes32) { return keccak256(bytes(name)); }

    // ---------- internals ----------
    function _check(uint64 nonce, bytes32 market, bool isBuy, uint256 sizeUsd, uint256 limitPx, uint256 stopPx, bool reduceOnly)
        internal view returns (string memory)
    {
        if (usedNonce[nonce]) return "nonce already used";
        if (paused) return "guard is paused";
        if (!allowedMarket[market]) return "market not allowed";
        if (reduceOnly) return isOpen[market] ? "" : "no open position to reduce";
        if (sizeUsd == 0 || limitPx == 0 || stopPx == 0) return "size, price and stop are required";
        if (sizeUsd > limits.maxOrderUsd) return "order larger than the max order size";
        if (isBuy ? stopPx >= limitPx : stopPx <= limitPx) return "stop on the wrong side";
        if (isOpen[market]) return "position already open in this market";
        if (openPositions >= limits.maxOpenPositions) return "max open positions reached";
        if (equityUsd <= 0) return "no equity";
        uint256 dist = isBuy ? limitPx - stopPx : stopPx - limitPx;
        uint256 riskUsd = sizeUsd * dist / limitPx;
        if (riskUsd * 10_000 > uint256(equityUsd) * limits.maxRiskBps) return "risk per order above the limit";
        int256 dayLoss = dayStartUsd - equityUsd;
        if (dayLoss > 0 && uint256(dayLoss) * 10_000 >= uint256(dayStartUsd) * limits.maxDailyLossBps) return "daily loss limit reached";
        if (_drawdownBps() >= limits.maxDrawdownBps) return "max drawdown reached";
        return "";
    }

    function _drawdownBps() internal view returns (uint256) {
        if (peakUsd <= 0 || equityUsd >= peakUsd) return 0;
        return uint256(peakUsd - equityUsd) * 10_000 / uint256(peakUsd);
    }

    function _rollDay() internal {
        uint64 d = uint64(block.timestamp / 1 days);
        if (d != day) { day = d; dayStartUsd = equityUsd; }
    }
}
