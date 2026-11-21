// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {CurrencySettler} from "@openzeppelin/uniswap-hooks/src/utils/CurrencySettler.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {UkiyoHook} from "./UkiyoHook.sol";

/// @title UkiyoVault
/// @author Abhist Kamle
/// @notice A curator vault for one Ukiyo sleeve. Depositors pool two tokens, receive ERC-20 shares, and the curator
///         runs the sleeve's range. The hook scores the curator's Edge; the vault is where depositors act on it.
///
/// @dev Entries and exits settle only at epoch boundaries. Requests made during an epoch are escrowed and settled
///      together by `settleEpoch`, which anyone can call once the epoch is over. Settling in batches keeps the share
///      price fixed within an epoch, so the Edge recorded for an epoch belongs to exactly the shares that held it,
///      and no one can enter right before fees are collected and leave right after.
///
///      Pricing needs no oracle:
///        - a deposit buys the same fraction of every token the vault holds (like a Uniswap v2 mint); whatever does
///          not fit that ratio is refunded. A manipulated pool price changes the ratio, not the fairness: moving the
///          price means trading against the sleeve, which leaves it worth more at the true price.
///        - a redemption takes its fraction of the position's liquidity and of the idle tokens.
///      Every rounding favours the vault: shares minted and amounts paid round down, amounts charged round up.
///
///      The curator is paid and held to account in Edge, not in fees or price:
///        - performance fee: a share of the epoch's Edge per share above its high-water mark, paid as new shares to
///          the curator. Negative epochs must be earned back before any fee is due.
///        - LVR bond: the curator can post a token1 bond and promise a budget for each epoch's negative Edge (as bps
///          of the vault's value). An epoch that loses more than the budget pays the overshoot from the bond to the
///          vault, capped at the bond. Bond withdrawals wait for the next settlement, after any penalty.
///      Both are valued at the hook's post-arbitrage mark, never the spot price of the settling transaction.
///
///      The curator controls the range only. Liquidity removed through the hook is always paid to this vault, and
///      the hook never lets anyone but this vault touch the sleeve once it is handed over, so the curator has no
///      path to depositors' tokens. The vault swaps only when its curator rebalances with `rebalanceWithSwap`, a bounded
///      swap the hook books as arbitrage; with plain `rebalance`, when a new range needs a different token mix, what does
///      not fit stays idle and still counts toward every share.
contract UkiyoVault is ERC20, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using CurrencySettler for Currency;

    // ---------------------------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice A pair of token amounts.
    /// @param amount0 Amount of token0.
    /// @param amount1 Amount of token1.
    struct Amounts {
        uint256 amount0;
        uint256 amount1;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Constants and immutables
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Most deposit requests one epoch accepts. Settlement loops over them, so the cap bounds its gas.
    uint256 public constant MAX_DEPOSITORS_PER_EPOCH = 32;

    /// @notice A new depositor must bring at least this fraction (bps) of the vault's holdings of one token. It stops
    ///         dust requests from filling the epoch's `MAX_DEPOSITORS_PER_EPOCH` slots, without needing a price.
    uint256 public constant MIN_DEPOSIT_BPS = 1;

    /// @notice Shares minted to a dead address on the first mint, so share price cannot be inflated from zero.
    uint256 public constant DEAD_SHARES = 1000;

    /// @notice Highest performance fee a vault can charge: 20% of Edge above the high-water mark.
    uint256 public constant MAX_PERFORMANCE_FEE_BPS = 2000;

    /// @notice Highest LVR budget a curator can promise: 10% of the vault's value per epoch.
    uint256 public constant MAX_LVR_BUDGET_BPS = 1000;

    /// @dev Fixed-point scale of `edgePerShare`.
    uint256 internal constant EPS_SCALE = 1e18;

    /// @dev `EPS_SCALE` as a signed integer, for the signed per-share arithmetic.
    int256 internal constant EPS_SCALE_SIGNED = 1e18;

    /// @dev Receiver of `DEAD_SHARES`.
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice The Ukiyo hook that meters this vault's sleeve.
    UkiyoHook public immutable hook;

    /// @notice The sleeve this vault manages.
    uint256 public immutable sleeveId;

    /// @notice The pool's currency0.
    IERC20 public immutable token0;

    /// @notice The pool's currency1.
    IERC20 public immutable token1;

    /// @notice The only address that may change the sleeve's range.
    address public immutable curator;

    /// @notice Minimum epoch length in seconds.
    uint256 public immutable epochLength;

    /// @notice Performance fee, in bps of Edge earned above the high-water mark.
    uint256 public immutable performanceFeeBps;

    /// @notice Most the pool price may move because of the vault's own rebalancing swap, in bps of price.
    uint256 public constant MAX_REBALANCE_MOVE_BPS = 100;

    /// @notice The PoolManager the hook's pool lives in; the vault swaps through it when it rebalances.
    IPoolManager public immutable poolManager;

    /// @dev The pool's fee and tick spacing, to rebuild its key for swaps.
    uint24 internal immutable _fee;
    int24 internal immutable _tickSpacing;

    /// @dev True only while `rebalanceWithSwap` waits on `unlock`, so the callback cannot be entered any other way.
    bool private transient _swapping;

    // ---------------------------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Index of the current epoch. Requests made now settle when it ends.
    uint256 public epoch;

    /// @notice Timestamp at which the current epoch started.
    uint256 public epochStart;

    /// @notice The sleeve's Edge (from the hook) when the current epoch started.
    int256 public epochStartEdge;

    /// @notice Tokens held for users and not part of the vault's capital: escrowed deposits, refunds and
    ///         redemption payouts waiting to be claimed.
    Amounts public reserved;

    /// @notice Escrowed deposit of `user` in `epoch`.
    mapping(uint256 epoch => mapping(address user => Amounts)) public pendingDeposit;

    /// @notice Shares `user` asked to redeem in `epoch`, held by the vault until claimed.
    mapping(uint256 epoch => mapping(address user => uint256)) public pendingRedeem;

    /// @notice All shares asked to be redeemed in `epoch`.
    mapping(uint256 epoch => uint256) public totalRedeem;

    /// @notice Tokens set aside at the end of `epoch` for its redeemers, shared pro rata to `pendingRedeem`.
    mapping(uint256 epoch => Amounts) public redeemPayout;

    /// @notice Tokens `user` can claim with `claimRefund`: the part of a deposit that did not fit the vault's ratio.
    mapping(address user => Amounts) public refunds;

    /// @notice Cumulative Edge per share, in token1 units scaled by 1e18. Each epoch adds its Edge divided by the shares
    ///         that held it.
    int256 public edgePerShare;

    /// @notice Highest `edgePerShare` a performance fee has been charged at. Fees are due only above it.
    int256 public highWaterMark;

    /// @notice token1 the curator has posted as bond. Not part of the vault's capital until a penalty moves it in.
    uint256 public bond;

    /// @notice Negative Edge the curator promises not to exceed in the current epoch, in bps of the vault's value.
    uint256 public lvrBudgetBps;

    /// @notice Budget that takes effect when the current epoch settles.
    uint256 public nextLvrBudgetBps;

    /// @notice Bond the curator asked to withdraw; paid at the next settlement, after any penalty.
    uint256 public bondWithdrawal;

    mapping(uint256 epoch => address[]) internal _depositors;
    mapping(uint256 epoch => mapping(address user => bool)) internal _isDepositor;

    // ---------------------------------------------------------------------------------------------------------------
    // Events and errors
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice A deposit was requested for the end of `epoch`.
    event DepositRequested(uint256 indexed epoch, address indexed user, uint256 amount0, uint256 amount1);

    /// @notice A pending deposit was withdrawn before settlement.
    event DepositCancelled(uint256 indexed epoch, address indexed user, uint256 amount0, uint256 amount1);

    /// @notice A redemption was requested for the end of `epoch`.
    event RedeemRequested(uint256 indexed epoch, address indexed user, uint256 shares);

    /// @notice A deposit was settled: `shares` minted for `used0`/`used1`; the rest is refundable.
    event DepositSettled(uint256 indexed epoch, address indexed user, uint256 shares, uint256 used0, uint256 used1);

    /// @notice An epoch was settled.
    /// @param edgeDelta The sleeve's Edge earned during the epoch, in raw token1 units.
    event EpochSettled(
        uint256 indexed epoch, int256 edgeDelta, uint256 sharesMinted, uint256 sharesBurned, uint128 liquidityAfter
    );

    /// @notice The curator moved the sleeve to a new range.
    event Rebalanced(int24 tickLower, int24 tickUpper, uint128 liquidity);

    /// @notice The curator was paid a performance fee of `shares`, worth `value` token1 at the mark.
    event PerformanceFee(uint256 indexed epoch, uint256 shares, uint256 value);

    /// @notice The epoch overshot the LVR budget by `overshoot`; `penalty` moved from the bond to the vault.
    event BondPenalty(uint256 indexed epoch, uint256 overshoot, uint256 penalty);

    /// @notice The curator posted `amount` of token1 as bond.
    event BondPosted(uint256 amount);

    /// @notice The curator asked to withdraw `amount` of bond at the next settlement.
    event BondWithdrawalRequested(uint256 amount);

    /// @notice `amount` of bond was paid back to the curator.
    event BondWithdrawn(uint256 amount);

    /// @notice The LVR budget for the next epoch was set.
    event LvrBudgetSet(uint256 bps);

    /// @notice Tokens were paid out to `user`.
    event Claimed(address indexed user, uint256 amount0, uint256 amount1);

    /// @notice The curator address is zero.
    error ZeroCurator();

    /// @notice Native-currency pools are not supported.
    error NativeCurrencyNotSupported();

    /// @notice The hook has no pool yet.
    error PoolNotBound();

    /// @notice Only the curator may do this.
    error NotCurator();

    /// @notice The current epoch ends at `endsAt`.
    error EpochNotOver(uint256 endsAt);

    /// @notice This epoch already has `MAX_DEPOSITORS_PER_EPOCH` depositors.
    error EpochFull();

    /// @notice Amount must be non-zero.
    error ZeroAmount();

    /// @notice That epoch has not been settled yet.
    error EpochNotSettled(uint256 epoch);

    /// @notice A new deposit request is below `MIN_DEPOSIT_BPS` of the vault's holdings in both tokens.
    error DepositTooSmall();

    /// @notice `unlockCallback` was called by something other than the PoolManager answering this vault's own swap.
    error NotOwnSwap();

    /// @notice A fee or budget is above its cap.
    error AboveCap(uint256 bps, uint256 cap);

    // ---------------------------------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------------------------------

    /// @param hook_ The Ukiyo hook; its pool must be initialized.
    /// @param sleeveId_ The sleeve to manage. The hook owner must then hand it over with `setSleeveManager`.
    /// @param curator_ The address that runs the sleeve's range.
    /// @param epochLength_ Minimum epoch length in seconds.
    /// @param performanceFeeBps_ Performance fee in bps of Edge above the high-water mark, at most 20%.
    /// @param name_ Share token name.
    /// @param symbol_ Share token symbol.
    constructor(
        UkiyoHook hook_,
        uint256 sleeveId_,
        address curator_,
        uint256 epochLength_,
        uint256 performanceFeeBps_,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) {
        if (curator_ == address(0)) revert ZeroCurator();
        if (performanceFeeBps_ > MAX_PERFORMANCE_FEE_BPS) {
            revert AboveCap(performanceFeeBps_, MAX_PERFORMANCE_FEE_BPS);
        }
        if (!hook_.poolBound()) revert PoolNotBound();
        // the hooks field is the hook itself
        // forge-lint: disable-next-line(unused-return)
        (Currency c0, Currency c1, uint24 fee, int24 spacing,) = hook_.poolKey();
        if (c0.isAddressZero()) revert NativeCurrencyNotSupported();
        hook = hook_;
        sleeveId = sleeveId_;
        token0 = IERC20(Currency.unwrap(c0));
        token1 = IERC20(Currency.unwrap(c1));
        curator = curator_;
        epochLength = epochLength_;
        performanceFeeBps = performanceFeeBps_;
        poolManager = hook_.poolManager();
        _fee = fee;
        _tickSpacing = spacing;
        epochStart = block.timestamp;
        epochStartEdge = hook_.edge(sleeveId_);
        // The hook pulls tokens from its caller when this vault adds liquidity.
        token0.forceApprove(address(hook_), type(uint256).max);
        token1.forceApprove(address(hook_), type(uint256).max);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Depositors
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Escrow tokens to join the vault at the end of the current epoch.
    /// @dev Send both tokens in about the vault's current ratio (see `holdings`); the part that does not fit the
    ///      ratio at settlement is refunded through `claimRefund`.
    /// @param amount0 token0 to escrow.
    /// @param amount1 token1 to escrow.
    function requestDeposit(uint256 amount0, uint256 amount1) external nonReentrant {
        if (amount0 == 0 && amount1 == 0) revert ZeroAmount();
        uint256 e = epoch;
        if (!_isDepositor[e][msg.sender]) {
            if (_depositors[e].length >= MAX_DEPOSITORS_PER_EPOCH) revert EpochFull();
            (uint256 h0, uint256 h1) = holdings();
            if (h0 + h1 != 0 && amount0 * 10_000 < h0 * MIN_DEPOSIT_BPS && amount1 * 10_000 < h1 * MIN_DEPOSIT_BPS) {
                revert DepositTooSmall();
            }
            _isDepositor[e][msg.sender] = true;
            _depositors[e].push(msg.sender);
        }
        Amounts storage d = pendingDeposit[e][msg.sender];
        d.amount0 += amount0;
        d.amount1 += amount1;
        reserved.amount0 += amount0;
        reserved.amount1 += amount1;
        if (amount0 != 0) token0.safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 != 0) token1.safeTransferFrom(msg.sender, address(this), amount1);
        emit DepositRequested(e, msg.sender, amount0, amount1);
    }

    /// @notice Take back this epoch's escrowed deposit before it settles.
    function cancelDeposit() external nonReentrant {
        uint256 e = epoch;
        Amounts memory d = pendingDeposit[e][msg.sender];
        if (d.amount0 == 0 && d.amount1 == 0) revert ZeroAmount();
        delete pendingDeposit[e][msg.sender];
        reserved.amount0 -= d.amount0;
        reserved.amount1 -= d.amount1;
        _pay(msg.sender, d.amount0, d.amount1);
        emit DepositCancelled(e, msg.sender, d.amount0, d.amount1);
    }

    /// @notice Hand shares to the vault to be redeemed at the end of the current epoch.
    /// @param shares Shares to redeem.
    function requestRedeem(uint256 shares) external nonReentrant {
        if (shares == 0) revert ZeroAmount();
        uint256 e = epoch;
        _transfer(msg.sender, address(this), shares);
        pendingRedeem[e][msg.sender] += shares;
        totalRedeem[e] += shares;
        emit RedeemRequested(e, msg.sender, shares);
    }

    /// @notice Claim the tokens owed for shares redeemed in a settled epoch.
    /// @param e The epoch the redemption was requested in.
    function claimRedemption(uint256 e) external nonReentrant {
        if (e >= epoch) revert EpochNotSettled(e);
        uint256 shares = pendingRedeem[e][msg.sender];
        if (shares == 0) revert ZeroAmount();
        delete pendingRedeem[e][msg.sender];
        Amounts memory p = redeemPayout[e];
        uint256 total = totalRedeem[e];
        uint256 out0 = Math.mulDiv(p.amount0, shares, total);
        uint256 out1 = Math.mulDiv(p.amount1, shares, total);
        reserved.amount0 -= out0;
        reserved.amount1 -= out1;
        _pay(msg.sender, out0, out1);
    }

    /// @notice Claim the parts of settled deposits that did not fit the vault's ratio.
    function claimRefund() external nonReentrant {
        Amounts memory r = refunds[msg.sender];
        if (r.amount0 == 0 && r.amount1 == 0) revert ZeroAmount();
        delete refunds[msg.sender];
        reserved.amount0 -= r.amount0;
        reserved.amount1 -= r.amount1;
        _pay(msg.sender, r.amount0, r.amount1);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Epochs
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Close the current epoch: collect fees, book the epoch's Edge (bond penalty, performance fee), pay
    ///         redemptions, mint deposits, deploy idle tokens, and pay any bond withdrawal. Anyone can call it once
    ///         the epoch is over.
    function settleEpoch() external nonReentrant {
        uint256 endsAt = epochStart + epochLength;
        // Epochs are days long; the few seconds a sequencer can skew a timestamp do not matter.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < endsAt) revert EpochNotOver(endsAt);
        uint256 e = epoch;
        // Requests made from here on belong to the next epoch.
        epoch = e + 1;
        epochStart = block.timestamp;

        // Every external call below goes to the hook, which only calls back into the PoolManager, and this function
        // is nonReentrant, so state written after the calls cannot be observed half-done.
        // forge-lint: disable-start(reentrancy-no-eth)
        // forge-lint: disable-start(reentrancy-events)
        // Collect fees first, so they belong to everyone who held shares during the epoch.
        uint128 liq = _liquidity();
        if (liq != 0) hook.modifySleeveLiquidity(sleeveId, 0);

        // The epoch's Edge belongs to the shares that held it, so it is booked before anyone enters or leaves.
        int256 edgeNow = hook.edge(sleeveId);
        int256 edgeDelta = edgeNow - epochStartEdge;
        _applyBond(e, edgeDelta);
        _chargePerformanceFee(e, edgeDelta);

        uint256 burned = _settleRedemptions(e, liq);
        uint256 minted = _settleDeposits(e);
        _deployIdle();
        _payBondWithdrawal();
        lvrBudgetBps = nextLvrBudgetBps;

        emit EpochSettled(e, edgeDelta, minted, burned, _liquidity());
        epochStartEdge = edgeNow;
        // forge-lint: disable-end(reentrancy-events)
        // forge-lint: disable-end(reentrancy-no-eth)
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Curator
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Post token1 as bond against the LVR budget. It never counts as depositors' capital unless a penalty moves
    ///         it in.
    /// @param amount token1 to add to the bond.
    function postBond(uint256 amount) external nonReentrant {
        _onlyCurator();
        if (amount == 0) revert ZeroAmount();
        bond += amount;
        token1.safeTransferFrom(msg.sender, address(this), amount);
        emit BondPosted(amount);
    }

    /// @notice Ask for bond back. It is paid at the next settlement, after that epoch's penalty, so a curator cannot
    ///         pull the bond out from under an epoch that is going badly.
    /// @param amount token1 to withdraw; replaces any earlier request.
    function requestBondWithdrawal(uint256 amount) external {
        _onlyCurator();
        bondWithdrawal = amount;
        emit BondWithdrawalRequested(amount);
    }

    /// @notice Set the LVR budget: the negative Edge per epoch, in bps of the vault's value, beyond which the bond pays
    ///         depositors. Takes effect from the next epoch, so it cannot be raised to escape the current one.
    /// @param bps The budget, at most `MAX_LVR_BUDGET_BPS`.
    function setLvrBudget(uint256 bps) external {
        _onlyCurator();
        if (bps > MAX_LVR_BUDGET_BPS) revert AboveCap(bps, MAX_LVR_BUDGET_BPS);
        nextLvrBudgetBps = bps;
        emit LvrBudgetSet(bps);
    }

    /// @notice Move the sleeve to a new range and redeploy as much of the vault's capital as fits it.
    /// @dev The hook anchors the sleeve at the current price, so the new range is never charged for earlier moves.
    /// @param tickLower New lower tick.
    /// @param tickUpper New upper tick.
    function rebalance(int24 tickLower, int24 tickUpper) external nonReentrant {
        _onlyCurator();
        // The hook is trusted and this function is nonReentrant (`_status` is the guard's own lock).
        // forge-lint: disable-start(reentrancy-events)
        // forge-lint: disable-start(reentrancy-no-eth)
        uint128 liq = _liquidity();
        if (liq != 0) hook.modifySleeveLiquidity(sleeveId, -int256(uint256(liq)));
        hook.setSleeveRange(sleeveId, tickLower, tickUpper);
        _deployIdle();
        emit Rebalanced(tickLower, tickUpper, _liquidity());
        // forge-lint: disable-end(reentrancy-no-eth)
        // forge-lint: disable-end(reentrancy-events)
    }

    /// @notice Move the sleeve to a new range, first swapping some idle tokens so the vault holds the mix the range
    ///         needs. Without it, a vault whose range the price ran through holds one token and cannot fund a range
    ///         around the price.
    /// @dev The swap goes through the hook's own pool. The hook classifies it as arbitrage (the vault is a sleeve
    ///      manager), so it can never add to any curator's Edge, and its price limit keeps the move within
    ///      `MAX_REBALANCE_MOVE_BPS`: a larger order simply fills partially.
    /// @param tickLower New lower tick.
    /// @param tickUpper New upper tick.
    /// @param zeroForOne True to sell token0 for token1, false for the reverse.
    /// @param amountIn Tokens to sell; capped at the vault's idle balance of that token.
    function rebalanceWithSwap(int24 tickLower, int24 tickUpper, bool zeroForOne, uint256 amountIn)
        external
        nonReentrant
    {
        _onlyCurator();
        if (amountIn == 0) revert ZeroAmount();
        // The hook and the PoolManager are trusted and this function is nonReentrant.
        // forge-lint: disable-start(reentrancy-events)
        // forge-lint: disable-start(reentrancy-no-eth)
        uint128 liq = _liquidity();
        if (liq != 0) hook.modifySleeveLiquidity(sleeveId, -int256(uint256(liq)));
        hook.setSleeveRange(sleeveId, tickLower, tickUpper);

        (uint256 i0, uint256 i1) = _idle();
        uint256 have = zeroForOne ? i0 : i1;
        if (amountIn > have) amountIn = have;
        if (amountIn != 0) {
            uint160 p = hook.sqrtPriceX96();
            // price is the square of the sqrt price, so half the bps on the sqrt price bounds the price move
            uint256 half = MAX_REBALANCE_MOVE_BPS / 2;
            uint160 limit = SafeCast.toUint160(
                zeroForOne ? Math.mulDiv(p, 10_000 - half, 10_000) : Math.mulDiv(p, 10_000 + half, 10_000)
            );
            _swapping = true;
            // unlockCallback settles the swap and returns nothing
            // forge-lint: disable-next-line(unused-return)
            poolManager.unlock(abi.encode(zeroForOne, amountIn, limit));
            _swapping = false;
        }
        _deployIdle();
        emit Rebalanced(tickLower, tickUpper, _liquidity());
        // forge-lint: disable-end(reentrancy-no-eth)
        // forge-lint: disable-end(reentrancy-events)
    }

    /// @inheritdoc IUnlockCallback
    /// @dev Runs only inside `rebalanceWithSwap`: swaps exact input, pays what the vault owes, takes what it is owed.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_swapping) revert NotOwnSwap();
        (bool zeroForOne, uint256 amountIn, uint160 limit) = abi.decode(data, (bool, uint256, uint160));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            fee: _fee,
            tickSpacing: _tickSpacing,
            hooks: IHooks(address(hook))
        });
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne, amountSpecified: -SafeCast.toInt256(amountIn), sqrtPriceLimitX96: limit
            }),
            ""
        );
        int128 a0 = d.amount0();
        int128 a1 = d.amount1();
        // negative = owed to the PoolManager, positive = owed to the vault
        if (a0 < 0) key.currency0.settle(poolManager, address(this), SafeCast.toUint256(-int256(a0)), false);
        if (a1 < 0) key.currency1.settle(poolManager, address(this), SafeCast.toUint256(-int256(a1)), false);
        if (a0 > 0) key.currency0.take(poolManager, address(this), SafeCast.toUint256(int256(a0)), false);
        if (a1 > 0) key.currency1.take(poolManager, address(this), SafeCast.toUint256(int256(a1)), false);
        return "";
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice The vault's capital: idle tokens plus the position's tokens at the current price. Excludes reserved
    ///         tokens and fees the position has not collected yet; rounds down.
    function holdings() public view returns (uint256 amount0, uint256 amount1) {
        (uint256 i0, uint256 i1) = _idle();
        (uint256 p0, uint256 p1) = hook.sleeveAmounts(sleeveId);
        return (i0 + p0, i1 + p1);
    }

    /// @notice The vault's capital in token1, with the position valued at the hook's post-arbitrage mark rather than the
    ///         spot price, so it cannot be moved within one transaction. Excludes reserved tokens and the bond.
    function valueAtMark() public view returns (uint256) {
        (uint256 i0, uint256 i1) = _idle();
        uint160 m = hook.lastPostMark();
        if (m == 0) m = hook.sqrtPriceX96();
        (uint256 p0, uint256 p1) = _positionAt(m);
        uint256 a0 = i0 + p0;
        return i1 + p1 + Math.mulDiv(Math.mulDiv(a0, m, 1 << 96), m, 1 << 96);
    }

    /// @notice When the current epoch can be settled.
    function epochEndsAt() external view returns (uint256) {
        return epochStart + epochLength;
    }

    /// @notice Number of deposit requests in `e`.
    function depositorCount(uint256 e) external view returns (uint256) {
        return _depositors[e].length;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev LVR bond: if the epoch's negative Edge overshoots the budget, move the overshoot (capped at the bond) from
    ///      the bond into the vault's capital. The budget rounds down, so the penalty is never understated.
    function _applyBond(uint256 e, int256 edgeDelta) internal {
        uint256 b = bond;
        if (edgeDelta >= 0 || b == 0) return;
        uint256 loss = SafeCast.toUint256(-edgeDelta);
        uint256 budget = Math.mulDiv(valueAtMark(), lvrBudgetBps, 10_000);
        if (loss <= budget) return;
        uint256 overshoot = loss - budget;
        uint256 penalty = Math.min(overshoot, b);
        bond = b - penalty;
        // the only external calls before this are the hook's views; callers are nonReentrant
        // forge-lint: disable-next-line(reentrancy-events)
        emit BondPenalty(e, overshoot, penalty);
    }

    /// @dev Performance fee: add the epoch's Edge per share, and if it is above the high-water mark, pay the curator
    ///      `performanceFeeBps` of the gain as new shares priced at the mark. Edge per share rounds down and the
    ///      fee's shares round down, so the curator is never paid for Edge that was not earned.
    function _chargePerformanceFee(uint256 e, int256 edgeDelta) internal {
        uint256 supply = totalSupply();
        if (supply == 0) return;
        int256 scaled = edgeDelta * EPS_SCALE_SIGNED;
        int256 s = SafeCast.toInt256(supply);
        int256 step = scaled / s;
        if (scaled < 0 && scaled % s != 0) step -= 1; // floor, not truncation toward zero
        int256 eps = edgePerShare + step;
        edgePerShare = eps;
        int256 hwm = highWaterMark;
        if (eps <= hwm) return;
        highWaterMark = eps;
        if (performanceFeeBps == 0) return;
        uint256 gain = Math.mulDiv(SafeCast.toUint256(eps - hwm), supply, EPS_SCALE);
        uint256 fee = Math.mulDiv(gain, performanceFeeBps, 10_000);
        uint256 value = valueAtMark();
        if (fee == 0 || fee >= value) return;
        uint256 shares = Math.mulDiv(fee, supply, value - fee);
        if (shares == 0) return;
        _mint(curator, shares);
        // the only external calls before this are the hook's views; callers are nonReentrant
        // forge-lint: disable-next-line(reentrancy-events)
        emit PerformanceFee(e, shares, fee);
    }

    /// @dev Pay the curator the bond withdrawal it asked for, as far as the bond still covers it.
    function _payBondWithdrawal() internal {
        uint256 amount = Math.min(bondWithdrawal, bond);
        bondWithdrawal = 0;
        if (amount == 0) return;
        bond -= amount;
        // callers are nonReentrant
        // forge-lint: disable-next-line(reentrancy-events)
        emit BondWithdrawn(amount);
        token1.safeTransfer(curator, amount);
    }

    /// @dev The position's tokens if the pool were at square-root price `p`; rounds down.
    function _positionAt(uint160 p) internal view returns (uint256 amount0, uint256 amount1) {
        uint128 l = _liquidity();
        if (l == 0) return (0, 0);
        (uint160 lo, uint160 hi) = _bounds();
        if (p < hi) amount0 = SqrtPriceMath.getAmount0Delta(p > lo ? p : lo, hi, l, false);
        if (p > lo) amount1 = SqrtPriceMath.getAmount1Delta(lo, p < hi ? p : hi, l, false);
    }

    /// @dev Reverts unless the caller is the curator.
    function _onlyCurator() internal view {
        if (msg.sender != curator) revert NotCurator();
    }

    /// @dev Set aside the redeemers' fraction of the position and of the idle tokens, and burn their shares.
    function _settleRedemptions(uint256 e, uint128 liq) internal returns (uint256 burned) {
        burned = totalRedeem[e];
        if (burned == 0) return 0;
        uint256 supply = totalSupply();
        (uint256 i0, uint256 i1) = _idle();
        uint256 out0 = Math.mulDiv(i0, burned, supply);
        uint256 out1 = Math.mulDiv(i1, burned, supply);
        uint256 liqOut = Math.mulDiv(liq, burned, supply);
        // forge-lint: disable-start(reentrancy-no-eth)
        // The hook is trusted and the caller is nonReentrant; the payout must be measured after the removal.
        if (liqOut != 0) {
            uint256 before0 = token0.balanceOf(address(this));
            uint256 before1 = token1.balanceOf(address(this));
            hook.modifySleeveLiquidity(sleeveId, -SafeCast.toInt256(liqOut));
            out0 += token0.balanceOf(address(this)) - before0;
            out1 += token1.balanceOf(address(this)) - before1;
        }
        redeemPayout[e] = Amounts(out0, out1);
        reserved.amount0 += out0;
        reserved.amount1 += out1;
        _burn(address(this), burned);
        // forge-lint: disable-end(reentrancy-no-eth)
    }

    /// @dev Running state of one epoch's deposit settlement.
    /// @param h0 Vault token0 holdings so far, including deposits already settled in this batch.
    /// @param h1 Vault token1 holdings so far.
    /// @param supply Share supply so far.
    /// @param p Pool square-root price.
    /// @param lo Sleeve's lower square-root price bound.
    /// @param hi Sleeve's upper square-root price bound.
    struct Book {
        uint256 h0;
        uint256 h1;
        uint256 supply;
        uint160 p;
        uint160 lo;
        uint160 hi;
    }

    /// @dev Mint shares for every deposit request of epoch `e`, in request order. Each deposit is priced against the
    ///      holdings left by the ones before it.
    function _settleDeposits(uint256 e) internal returns (uint256 minted) {
        address[] storage users = _depositors[e];
        uint256 n = users.length;
        if (n == 0) return 0;
        Book memory b;
        (b.h0, b.h1) = holdings();
        b.supply = totalSupply();
        (b.lo, b.hi) = _bounds();
        b.p = hook.sqrtPriceX96();
        for (uint256 k; k < n; ++k) {
            minted += _settleDeposit(e, users[k], b);
        }
    }

    /// @dev Settle one escrowed deposit: mint its shares and book what did not fit the vault's ratio as a refund.
    function _settleDeposit(uint256 e, address user, Book memory b) internal returns (uint256 shares) {
        Amounts memory d = pendingDeposit[e][user];
        if (d.amount0 == 0 && d.amount1 == 0) return 0;
        delete pendingDeposit[e][user];

        uint256 used0;
        uint256 used1;
        (shares, used0, used1) = _quote(d, b);
        if (shares != 0 && b.supply == 0) {
            // First mint: lock a sliver of shares forever so the share price cannot be inflated from zero.
            if (shares <= DEAD_SHARES) {
                (shares, used0, used1) = (0, 0, 0);
            } else {
                _mint(DEAD, DEAD_SHARES);
                b.supply = DEAD_SHARES;
                shares -= DEAD_SHARES;
            }
        }
        if (shares != 0) {
            _mint(user, shares);
            b.supply += shares;
            b.h0 += used0;
            b.h1 += used1;
        }
        // The escrow leaves `reserved`; whatever was not used stays in it as the user's refund.
        reserved.amount0 -= used0;
        reserved.amount1 -= used1;
        if (d.amount0 != used0 || d.amount1 != used1) {
            Amounts storage r = refunds[user];
            r.amount0 += d.amount0 - used0;
            r.amount1 += d.amount1 - used1;
        }
        // the only earlier external calls are the hook's views; every caller is nonReentrant
        // forge-lint: disable-next-line(reentrancy-events)
        emit DepositSettled(e, user, shares, used0, used1);
    }

    /// @dev Shares a deposit buys and the tokens it uses. Into an empty vault, shares are the liquidity the deposit
    ///      adds at the current price; otherwise the deposit buys the same fraction of each token the vault holds.
    function _quote(Amounts memory d, Book memory b)
        internal
        pure
        returns (uint256 shares, uint256 used0, uint256 used1)
    {
        if (b.supply == 0) {
            (uint160 p, uint160 lo, uint160 hi) = (b.p, b.lo, b.hi);
            uint128 l = LiquidityAmounts.getLiquidityForAmounts(p, lo, hi, d.amount0, d.amount1);
            if (l == 0) return (0, 0, 0);
            if (p < hi) used0 = SqrtPriceMath.getAmount0Delta(p > lo ? p : lo, hi, l, true);
            if (p > lo) used1 = SqrtPriceMath.getAmount1Delta(lo, p < hi ? p : hi, l, true);
            // Rounding up can only reach the deposit itself, never exceed it; the min is a belt for that.
            return (l, Math.min(used0, d.amount0), Math.min(used1, d.amount1));
        }
        if (b.h0 == 0 && b.h1 == 0) return (0, 0, 0);
        uint256 s0 = b.h0 == 0 ? type(uint256).max : Math.mulDiv(d.amount0, b.supply, b.h0);
        uint256 s1 = b.h1 == 0 ? type(uint256).max : Math.mulDiv(d.amount1, b.supply, b.h1);
        shares = Math.min(s0, s1);
        if (shares == 0) return (0, 0, 0);
        used0 = Math.mulDiv(shares, b.h0, b.supply, Math.Rounding.Ceil);
        used1 = Math.mulDiv(shares, b.h1, b.supply, Math.Rounding.Ceil);
    }

    /// @dev Add as much liquidity as the idle tokens allow at the current range and price.
    function _deployIdle() internal {
        (uint256 i0, uint256 i1) = _idle();
        if (i0 == 0 && i1 == 0) return;
        (uint160 lo, uint160 hi) = _bounds();
        uint128 l = LiquidityAmounts.getLiquidityForAmounts(hook.sqrtPriceX96(), lo, hi, i0, i1);
        // callers are nonReentrant; `_status` is the guard's own lock
        // forge-lint: disable-next-line(reentrancy-no-eth)
        if (l != 0) hook.modifySleeveLiquidity(sleeveId, int256(uint256(l)));
    }

    /// @dev Tokens on hand that belong to the vault's capital: everything but users' reserved tokens and the bond.
    function _idle() internal view returns (uint256 i0, uint256 i1) {
        Amounts memory r = reserved;
        i0 = token0.balanceOf(address(this)) - r.amount0;
        i1 = token1.balanceOf(address(this)) - r.amount1 - bond;
    }

    /// @dev The sleeve's current liquidity.
    function _liquidity() internal view returns (uint128) {
        return hook.sleeve(sleeveId).liquidity;
    }

    /// @dev Square-root price bounds of the sleeve's range.
    function _bounds() internal view returns (uint160 lo, uint160 hi) {
        UkiyoHook.Sleeve memory s = hook.sleeve(sleeveId);
        return (TickMath.getSqrtPriceAtTick(s.tickLower), TickMath.getSqrtPriceAtTick(s.tickUpper));
    }

    /// @dev Transfer both tokens out.
    function _pay(address to, uint256 amount0, uint256 amount1) internal {
        // emitted before the transfers; callers are nonReentrant
        // forge-lint: disable-next-line(reentrancy-events)
        emit Claimed(to, amount0, amount1);
        if (amount0 != 0) token0.safeTransfer(to, amount0);
        if (amount1 != 0) token1.safeTransfer(to, amount1);
    }
}
