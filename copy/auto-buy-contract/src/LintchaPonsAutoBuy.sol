// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPonsV2LaunchFactory {
    function getLaunchedToken(address token)
        external
        view
        returns (
            address launchedToken,
            address curve,
            address deployer,
            address creatorFeeRecipient,
            address pairToken,
            uint256 graduationThreshold,
            uint24 poolFee,
            int24 tickSpacing,
            uint16 creatorTaxBps,
            bool buybackEnabled,
            uint8 phase,
            uint256 sweptQuote,
            uint256 sweptTokens,
            uint64 sweptAt,
            bool exists
        );
}

interface IPonsV2BondingCurve {
    function factory() external view returns (address);
    function token() external view returns (address);
    function pairToken() external view returns (address);
    function feeBps() external view returns (uint16);
    function creatorTaxBps() external view returns (uint16);
    function reservedTokens() external view returns (uint256);
    function graduated() external view returns (bool);
    function readyToGraduate() external view returns (bool);
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable;
}

/// @notice A deliberately narrow session target for Lintcha Copy auto-BUY.
/// @dev It has no arbitrary call, token approval, SELL, upgrade, custody, or owner withdrawal path.
contract LintchaPonsAutoBuy {
    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_SLIPPAGE_BPS = 2_000;
    uint64 public constant MAX_AUTHORIZATION_LIFETIME = 365 days;

    struct Limits {
        uint128 maxPerTradeWei;
        uint128 maxDailyWei;
        uint16 maxSlippageBps;
        uint64 expiresAt;
        bool paused;
    }

    struct DailySpend {
        uint64 day;
        uint192 amountWei;
    }

    error Unauthorized();
    error GloballyPaused();
    error UserPaused();
    error AuthorizationExpired();
    error InvalidLimits();
    error InvalidAmount();
    error PerTradeCapExceeded();
    error DailyCapExceeded();
    error UnsupportedLaunch();
    error UnsupportedQuoteAsset();
    error CurveNotLive();
    error ProvenanceMismatch();
    error InvalidFeePolicy();
    error SlippageLimitExceeded();
    error PartialFillForbidden();
    error BuyFailed();
    error RefundFailed();
    error Reentrancy();

    event GlobalPauseChanged(bool paused);
    event LimitsConfigured(address indexed user, uint128 maxPerTradeWei, uint128 maxDailyWei, uint16 maxSlippageBps, uint64 expiresAt);
    event UserPauseChanged(address indexed user, bool paused);
    event AutoBuyExecuted(address indexed user, address indexed token, address indexed curve, uint256 amountIn, uint256 minimumOutput, uint64 day);

    address public immutable owner;
    IPonsV2LaunchFactory public immutable factory;
    bool public globalPaused = true;

    mapping(address => Limits) public limits;
    mapping(address => DailySpend) public dailySpend;

    uint256 private locked = 1;

    constructor(address factory_, address owner_) {
        if (factory_ == address(0) || owner_ == address(0)) revert InvalidLimits();
        factory = IPonsV2LaunchFactory(factory_);
        owner = owner_;
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    function setGlobalPaused(bool paused_) external {
        if (msg.sender != owner) revert Unauthorized();
        globalPaused = paused_;
        emit GlobalPauseChanged(paused_);
    }

    function configure(uint128 maxPerTradeWei, uint128 maxDailyWei, uint16 maxSlippageBps, uint64 expiresAt) external {
        if (
            maxPerTradeWei == 0 || maxDailyWei < maxPerTradeWei || maxSlippageBps > MAX_SLIPPAGE_BPS
                || expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_AUTHORIZATION_LIFETIME
        ) revert InvalidLimits();
        limits[msg.sender] = Limits(maxPerTradeWei, maxDailyWei, maxSlippageBps, expiresAt, false);
        emit LimitsConfigured(msg.sender, maxPerTradeWei, maxDailyWei, maxSlippageBps, expiresAt);
    }

    function setUserPaused(bool paused_) external {
        Limits storage configured = limits[msg.sender];
        if (configured.expiresAt == 0) revert InvalidLimits();
        configured.paused = paused_;
        emit UserPauseChanged(msg.sender, paused_);
    }

    function buy(address token_, uint256 amountIn, uint256 minimumOutput) external payable nonReentrant {
        if (globalPaused) revert GloballyPaused();
        Limits memory configured = limits[msg.sender];
        if (configured.paused) revert UserPaused();
        if (configured.expiresAt <= block.timestamp) revert AuthorizationExpired();
        if (amountIn == 0 || msg.value != amountIn || minimumOutput == 0) revert InvalidAmount();
        if (amountIn > configured.maxPerTradeWei) revert PerTradeCapExceeded();

        uint64 day = uint64(block.timestamp / 1 days);
        DailySpend storage spent = dailySpend[msg.sender];
        uint256 used = spent.day == day ? spent.amountWei : 0;
        if (used + amountIn > configured.maxDailyWei) revert DailyCapExceeded();

        address curve = _resolveCurve(token_);
        IPonsV2BondingCurve venue = IPonsV2BondingCurve(curve);
        if (venue.factory() != address(factory) || venue.token() != token_) revert ProvenanceMismatch();
        if (venue.pairToken() != address(0)) revert UnsupportedQuoteAsset();
        if (venue.graduated() || venue.readyToGraduate()) revert CurveNotLive();
        _validateOutput(venue, amountIn, minimumOutput, configured.maxSlippageBps);

        spent.day = day;
        spent.amountWei = uint192(used + amountIn);
        uint256 balanceBefore = address(this).balance - msg.value;
        try venue.buy{value: amountIn}(amountIn, minimumOutput, msg.sender) {} catch {
            revert BuyFailed();
        }
        uint256 refund = address(this).balance - balanceBefore;
        if (refund != 0) {
            spent.amountWei -= uint192(refund);
            (bool ok,) = payable(msg.sender).call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
        emit AutoBuyExecuted(msg.sender, token_, curve, amountIn - refund, minimumOutput, day);
    }

    function _resolveCurve(address token_) private view returns (address curve) {
        (address launchedToken, address resolvedCurve,,,,,,,,, uint8 phase,,,, bool exists) = factory.getLaunchedToken(token_);
        if (!exists || launchedToken != token_ || resolvedCurve == address(0)) revert UnsupportedLaunch();
        if (phase != 0) revert CurveNotLive();
        return resolvedCurve;
    }

    function _validateOutput(IPonsV2BondingCurve venue, uint256 amountIn, uint256 minimumOutput, uint16 maxSlippageBps) private view {
        uint256 feeAndTax = uint256(venue.feeBps()) + venue.creatorTaxBps();
        if (feeAndTax > MAX_SLIPPAGE_BPS || feeAndTax >= BPS) revert InvalidFeePolicy();
        (uint256 quoteReserve, uint256 tokenReserve) = venue.getReserves();
        if (quoteReserve == 0 || tokenReserve == 0) revert InvalidFeePolicy();
        uint256 netInput = amountIn * (BPS - feeAndTax) / BPS;
        uint256 expectedOutput = netInput * tokenReserve / (quoteReserve + netInput);
        uint256 reserved = venue.reservedTokens();
        if (reserved >= tokenReserve || expectedOutput > tokenReserve - reserved) revert PartialFillForbidden();
        uint256 lowestAllowed = expectedOutput * (BPS - maxSlippageBps) / BPS;
        if (minimumOutput < lowestAllowed || minimumOutput > expectedOutput) revert SlippageLimitExceeded();
    }
}
