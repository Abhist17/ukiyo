// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {CurrencySettler} from "@openzeppelin/uniswap-hooks/src/utils/CurrencySettler.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";

import {EdgeMath} from "./libraries/EdgeMath.sol";

/// @title UkiyoHook
/// @author Abhist Kamle
/// @notice The LVR meter behind Ukiyo, an honest scoreboard for curated liquidity on Uniswap v4.
///
/// @dev What it measures. Each curator runs one hook-owned position ("sleeve") in a hook-exclusive pool. For every
///      sleeve the hook keeps a ledger and reports
///
///          Edge = user fees + user impact - arbitrage loss
///
///      which the Ukiyo backtest showed tracks a curator's true hedged P&L (fees minus LVR marked at CEX prices)
///      with correlation 0.99 on a full year of real BTC/USD prices. The naive on-chain version, fees minus LVR at
///      pool prices, overstates every curator: pool-marked LVR is LVR net of the fees arbitrageurs pay, so their
///      fees must not be counted as income.
///
///      How. Two marks per block and one classification per swap:
///        - s*_k, the price right after the first swap of block k (the arbitrage slot under priority ordering),
///          recorded in `afterSwap`.
///        - the close of block k, read in the next block's first `beforeSwap` (nothing can move the price between).
///        - each swap is classified as arbitrage when its priority fee (`tx.gasprice - block.basefee`) is at or above
///          `priorityFeeThreshold`. Set the threshold low: when in doubt, call it arbitrage. The backtest showed that
///          a classifier that never misses an arbitrage never overstates Edge.
///
///      Terms, per sleeve (see EdgeMath):
///        - arbitrage loss  += l (s*_k - s*_{k-1})^2 / s*_{k-1}     on each block's first swap
///        - user impact     += l (close_k - s*_k)^2 / s*_k          on the next block's first swap
///        - user fees       += the sleeve's LP fee on every swap classified as user flow
///        - arbitrage fees   are tracked too, for transparency, and never count toward Edge
///
///      Known approximations, all bounded to one block for one sleeve: liquidity and range changes take effect from
///      the moment they happen, so the block in which a sleeve changes is measured with its new shape. LP fees are
///      computed from the price path and assume no protocol fee.
contract UkiyoHook is BaseHook, Ownable, IUnlockCallback {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using CurrencySettler for Currency;

    // ---------------------------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice A curator's hook-owned position.
    /// @param curator Address credited with this sleeve's Edge.
    /// @param tickLower Lower tick of the position.
    /// @param tickUpper Upper tick of the position.
    /// @param liquidity Current liquidity of the position.
    /// @param anchor Square-root price at which the sleeve last changed shape, or 0. While set, it replaces the global
    ///        post-arbitrage mark for this sleeve, so a new range is never charged for moves that happened before it.
    struct Sleeve {
        address curator;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint160 anchor;
    }

    /// @notice Running totals for one sleeve, all in raw token1 units.
    /// @param userFees LP fees from swaps classified as user flow. Counts toward Edge.
    /// @param userImpact Credit for user price impact that arbitrage later reverts. Counts toward Edge.
    /// @param arbLoss Rebalancing loss between consecutive post-arbitrage marks. Counts against Edge.
    /// @param arbFees LP fees from swaps classified as arbitrage. Reported, never counted.
    struct Ledger {
        uint256 userFees;
        uint256 userImpact;
        uint256 arbLoss;
        uint256 arbFees;
    }

    /// @dev Payload passed through `PoolManager.unlock` to `unlockCallback`.
    struct LiquidityCall {
        uint256 sleeveId;
        int256 liquidityDelta;
        address counterparty;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Constants and storage
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Most sleeves one pool can hold. Each swap's bookkeeping loops over them, so the cap bounds gas.
    uint256 public constant MAX_SLEEVES = 8;

    /// @notice The single pool this hook serves. Set once, at initialization.
    PoolKey public poolKey;

    /// @notice Whether `poolKey` has been set.
    bool public poolBound;

    /// @notice Swaps paying at least this priority fee per gas (wei) are classified as arbitrage.
    uint256 public priorityFeeThreshold;

    /// @notice Block number of the last block that had a swap, i.e. the block whose post-arbitrage mark is stored.
    uint256 public lastMarkedBlock;

    /// @notice Post-arbitrage mark s* of `lastMarkedBlock` (Q64.96 square-root price).
    uint160 public lastPostMark;

    /// @notice True while the user-impact term of `lastMarkedBlock` is still to be credited.
    bool public impactPending;

    /// @notice The contract allowed to move a sleeve's liquidity and range, usually its curator vault. While unset,
    ///         the owner manages the sleeve. Set once: an owner who could re-point it could pull a vault's liquidity
    ///         to themselves, because liquidity removals pay out to the caller.
    mapping(uint256 sleeveId => address) public sleeveManager;

    Sleeve[] internal _sleeves;
    mapping(uint256 sleeveId => Ledger) internal _ledgers;

    /// @dev Pool price before the current swap. Scratch value for one swap, so transient (EIP-1153).
    uint160 private transient _sqrtPriceBeforeSwap;

    /// @dev Classification of the current swap.
    bool private transient _swapIsArbitrage;

    /// @dev Whether the current swap is the first swap of its block.
    bool private transient _swapIsFirstInBlock;

    // ---------------------------------------------------------------------------------------------------------------
    // Events and errors
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Emitted when a sleeve is opened.
    event SleeveOpened(uint256 indexed sleeveId, address indexed curator, int24 tickLower, int24 tickUpper);

    /// @notice Emitted when a sleeve's range changes.
    event SleeveRangeSet(uint256 indexed sleeveId, int24 tickLower, int24 tickUpper);

    /// @notice Emitted when a sleeve's liquidity changes.
    event SleeveLiquidityModified(uint256 indexed sleeveId, int256 liquidityDelta, uint128 liquidityAfter);

    /// @notice Emitted on every swap with the hook's classification of it.
    event SwapClassified(uint256 indexed blockNumber, bool isArbitrage, uint256 priorityFeePerGas);

    /// @notice Emitted when a block's post-arbitrage mark is recorded.
    event BlockMarked(uint256 indexed blockNumber, uint160 sqrtPostMarkX96);

    /// @notice Emitted when the arbitrage threshold changes.
    event PriorityFeeThresholdSet(uint256 threshold);

    /// @notice Emitted when a sleeve is handed to its manager for good.
    event SleeveManagerSet(uint256 indexed sleeveId, address indexed manager);

    /// @notice The hook is already bound to a pool.
    error PoolAlreadyBound();

    /// @notice The pool uses a dynamic fee; Ukiyo's fee attribution needs a static LP fee.
    error DynamicFeeNotSupported();

    /// @notice No pool has been initialized with this hook yet.
    error PoolNotBound();

    /// @notice Liquidity in this pool can only be added or removed by the hook itself.
    error OnlyHookLiquidity();

    /// @notice The pool already holds `MAX_SLEEVES` sleeves.
    error TooManySleeves();

    /// @notice No sleeve with this id.
    error UnknownSleeve(uint256 sleeveId);

    /// @notice Ticks are unordered, out of bounds or not multiples of the pool's tick spacing.
    error InvalidRange(int24 tickLower, int24 tickUpper);

    /// @notice A sleeve's range can only change while it holds no liquidity.
    error SleeveNotEmpty(uint256 sleeveId);

    /// @notice The sleeve already has a manager, or the manager address is zero.
    error InvalidSleeveManager(uint256 sleeveId);

    /// @notice The caller may not move this sleeve's liquidity or range.
    error NotSleeveController(uint256 sleeveId, address caller);

    // ---------------------------------------------------------------------------------------------------------------
    // Construction and admin
    // ---------------------------------------------------------------------------------------------------------------

    /// @param manager The Uniswap v4 PoolManager.
    /// @param initialOwner Admin who opens sleeves and manages liquidity until the curator vaults land.
    /// @param threshold Initial `priorityFeeThreshold` in wei per gas.
    constructor(IPoolManager manager, address initialOwner, uint256 threshold) BaseHook(manager) Ownable(initialOwner) {
        priorityFeeThreshold = threshold;
        emit PriorityFeeThresholdSet(threshold);
    }

    /// @inheritdoc BaseHook
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @notice Set the priority fee per gas at or above which a swap counts as arbitrage.
    /// @param threshold New threshold in wei per gas.
    function setPriorityFeeThreshold(uint256 threshold) external onlyOwner {
        priorityFeeThreshold = threshold;
        emit PriorityFeeThresholdSet(threshold);
    }

    /// @notice Hand a sleeve to its manager (a curator vault) for good. From then on only the manager can move the
    ///         sleeve's liquidity or range; the owner keeps no way to touch it.
    /// @param sleeveId Sleeve to hand over.
    /// @param manager Contract that will control the sleeve.
    function setSleeveManager(uint256 sleeveId, address manager) external onlyOwner {
        _sleeve(sleeveId);
        if (manager == address(0) || sleeveManager[sleeveId] != address(0)) revert InvalidSleeveManager(sleeveId);
        sleeveManager[sleeveId] = manager;
        emit SleeveManagerSet(sleeveId, manager);
    }

    /// @dev The sleeve's manager if it has one, otherwise the owner.
    modifier onlySleeveController(uint256 sleeveId) {
        address m = sleeveManager[sleeveId];
        if (m == address(0) ? msg.sender != owner() : msg.sender != m) {
            revert NotSleeveController(sleeveId, msg.sender);
        }
        _;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Sleeve management
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Open an empty sleeve for a curator.
    /// @param curator Address credited with the sleeve's Edge.
    /// @param tickLower Lower tick, a multiple of the pool's tick spacing.
    /// @param tickUpper Upper tick, a multiple of the pool's tick spacing.
    /// @return sleeveId Index of the new sleeve.
    function openSleeve(address curator, int24 tickLower, int24 tickUpper)
        external
        onlyOwner
        returns (uint256 sleeveId)
    {
        if (!poolBound) revert PoolNotBound();
        if (_sleeves.length >= MAX_SLEEVES) revert TooManySleeves();
        _checkRange(tickLower, tickUpper);
        sleeveId = _sleeves.length;
        _sleeves.push(
            Sleeve({
                curator: curator, tickLower: tickLower, tickUpper: tickUpper, liquidity: 0, anchor: _currentSqrtPrice()
            })
        );
        emit SleeveOpened(sleeveId, curator, tickLower, tickUpper);
    }

    /// @notice Move an empty sleeve to a new range.
    /// @dev The range can only change while the sleeve is empty, so no position is ever orphaned in the PoolManager.
    /// @param sleeveId Sleeve to move.
    /// @param tickLower New lower tick.
    /// @param tickUpper New upper tick.
    function setSleeveRange(uint256 sleeveId, int24 tickLower, int24 tickUpper)
        external
        onlySleeveController(sleeveId)
    {
        Sleeve storage s = _sleeve(sleeveId);
        if (s.liquidity != 0) revert SleeveNotEmpty(sleeveId);
        _checkRange(tickLower, tickUpper);
        s.tickLower = tickLower;
        s.tickUpper = tickUpper;
        s.anchor = _currentSqrtPrice();
        emit SleeveRangeSet(sleeveId, tickLower, tickUpper);
    }

    /// @notice Add or remove liquidity in a sleeve. Tokens come from, or go to, the caller.
    /// @dev Adding pulls tokens with `transferFrom`, so the caller must approve this hook for both tokens first.
    ///      Fees the position has accrued in the PoolManager are paid out to the caller on every modification.
    /// @param sleeveId Sleeve to modify.
    /// @param liquidityDelta Positive to add, negative to remove.
    function modifySleeveLiquidity(uint256 sleeveId, int256 liquidityDelta) external onlySleeveController(sleeveId) {
        _sleeve(sleeveId);
        // unlockCallback returns no data, so the bytes unlock passes back carry nothing to check
        // forge-lint: disable-start(unused-return)
        poolManager.unlock(
            abi.encode(LiquidityCall({sleeveId: sleeveId, liquidityDelta: liquidityDelta, counterparty: msg.sender}))
        );
        // forge-lint: disable-end(unused-return)
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        LiquidityCall memory call = abi.decode(data, (LiquidityCall));
        Sleeve storage s = _sleeves[call.sleeveId];

        // feesAccrued is already included in callerDelta, which is what gets settled
        // forge-lint: disable-start(unused-return)
        (BalanceDelta callerDelta,) = poolManager.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({
                tickLower: s.tickLower,
                tickUpper: s.tickUpper,
                liquidityDelta: call.liquidityDelta,
                salt: bytes32(call.sleeveId)
            }),
            ""
        );
        // forge-lint: disable-end(unused-return)

        _settleOrTake(poolKey.currency0, callerDelta.amount0(), call.counterparty);
        _settleOrTake(poolKey.currency1, callerDelta.amount1(), call.counterparty);

        uint128 after_ = call.liquidityDelta >= 0
            ? s.liquidity + SafeCast.toUint128(SafeCast.toUint256(call.liquidityDelta))
            : s.liquidity - SafeCast.toUint128(SafeCast.toUint256(-call.liquidityDelta));
        s.liquidity = after_;
        // the only external callee is the PoolManager, which is trusted and holds its own lock
        // forge-lint: disable-next-line(reentrancy-events)
        emit SleeveLiquidityModified(call.sleeveId, call.liquidityDelta, after_);
        return "";
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Number of sleeves.
    function sleeveCount() external view returns (uint256) {
        return _sleeves.length;
    }

    /// @notice A sleeve's current shape.
    function sleeve(uint256 sleeveId) external view returns (Sleeve memory) {
        return _sleeves[sleeveId];
    }

    /// @notice A sleeve's running totals.
    function ledger(uint256 sleeveId) external view returns (Ledger memory) {
        return _ledgers[sleeveId];
    }

    /// @notice A sleeve's Edge so far: user fees + user impact - arbitrage loss, in raw token1 units.
    /// @dev Excludes the impact of the most recent block, which is credited on the next block's first swap.
    function edge(uint256 sleeveId) external view returns (int256) {
        Ledger storage l = _ledgers[sleeveId];
        return SafeCast.toInt256(l.userFees + l.userImpact) - SafeCast.toInt256(l.arbLoss);
    }

    /// @notice The bound pool's current square-root price (Q64.96), or 0 before initialization.
    function sqrtPriceX96() external view returns (uint160) {
        return _currentSqrtPrice();
    }

    /// @notice Tokens a sleeve's position holds at the current price, excluding fees not yet collected.
    /// @dev Rounds down, so a vault valuing itself from this never overstates its holdings.
    function sleeveAmounts(uint256 sleeveId) external view returns (uint256 amount0, uint256 amount1) {
        Sleeve storage s = _sleeve(sleeveId);
        if (s.liquidity == 0) return (0, 0);
        (uint160 lo, uint160 hi) = _bounds(s);
        uint160 p = _currentSqrtPrice();
        if (p < hi) amount0 = SqrtPriceMath.getAmount0Delta(p > lo ? p : lo, hi, s.liquidity, false);
        if (p > lo) amount1 = SqrtPriceMath.getAmount1Delta(lo, p < hi ? p : hi, s.liquidity, false);
    }

    /// @notice Classify the current transaction: true if its priority fee per gas meets the threshold.
    function isArbitrage() public view returns (bool) {
        return _priorityFee() >= priorityFeeThreshold;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Hook callbacks
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev Bind the hook to the first pool initialized with it and refuse dynamic-fee pools.
    function _beforeInitialize(address, PoolKey calldata key, uint160) internal override returns (bytes4) {
        if (poolBound) revert PoolAlreadyBound();
        if (LPFeeLibrary.isDynamicFee(key.fee)) revert DynamicFeeNotSupported();
        poolKey = key;
        poolBound = true;
        return this.beforeInitialize.selector;
    }

    /// @dev Only the hook may add liquidity: every position in the pool is a sleeve.
    function _beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4)
    {
        if (sender != address(this)) revert OnlyHookLiquidity();
        return this.beforeAddLiquidity.selector;
    }

    /// @dev Only the hook may remove liquidity.
    function _beforeRemoveLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4)
    {
        if (sender != address(this)) revert OnlyHookLiquidity();
        return this.beforeRemoveLiquidity.selector;
    }

    /// @dev On a block's first swap, credit the previous marked block's user impact; then remember this swap's
    ///      starting price and classification for `_afterSwap`.
    function _beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        uint160 sqrtPrice = _currentSqrtPrice();
        bool first = block.number != lastMarkedBlock;

        if (first && impactPending) {
            // `sqrtPrice` is the close of `lastMarkedBlock`: no swap has touched the pool since.
            _creditImpact(sqrtPrice);
            impactPending = false;
        }

        uint256 priorityFee = _priorityFee();
        bool arb = priorityFee >= priorityFeeThreshold;
        _sqrtPriceBeforeSwap = sqrtPrice;
        _swapIsArbitrage = arb;
        _swapIsFirstInBlock = first;
        // the only external call before this is the PoolManager's read-only getSlot0
        // forge-lint: disable-next-line(reentrancy-events)
        emit SwapClassified(block.number, arb, priorityFee);

        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// @dev Attribute this swap's LP fees to each sleeve; on a block's first swap, record s* and charge the
    ///      arbitrage loss since the previous mark.
    function _afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        uint160 sqrtAfter = _currentSqrtPrice();
        _attributeFees(_sqrtPriceBeforeSwap, sqrtAfter, key.fee, _swapIsArbitrage);

        if (_swapIsFirstInBlock) {
            _chargeArbitrageLoss(sqrtAfter);
            lastPostMark = sqrtAfter;
            lastMarkedBlock = block.number;
            impactPending = true;
            // the only external calls before this are the PoolManager's read-only getSlot0
            // forge-lint: disable-next-line(reentrancy-events)
            emit BlockMarked(block.number, sqrtAfter);
        }
        return (this.afterSwap.selector, 0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Accounting internals
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev Credit each sleeve with the net user displacement of `lastMarkedBlock`: from its post-arbitrage mark
    ///      (or the sleeve's anchor, if it changed shape after that mark) to the block's close.
    function _creditImpact(uint160 sqrtClose) internal {
        uint256 n = _sleeves.length;
        for (uint256 i; i < n; ++i) {
            Sleeve storage s = _sleeves[i];
            if (s.liquidity == 0) continue;
            uint160 from = s.anchor != 0 ? s.anchor : lastPostMark;
            (uint160 lo, uint160 hi) = _bounds(s);
            uint256 credit = EdgeMath.impactCredit(s.liquidity, from, sqrtClose, lo, hi);
            if (credit != 0) _ledgers[i].userImpact += credit;
        }
    }

    /// @dev Charge each sleeve the rebalancing loss between consecutive post-arbitrage marks, then clear anchors.
    ///      A sleeve with an anchor is charged from the anchor instead (the price at which it opened or re-ranged).
    ///      Before the pool's first mark there is no global reference, so only anchored sleeves are charged.
    function _chargeArbitrageLoss(uint160 sqrtPost) internal {
        uint256 n = _sleeves.length;
        for (uint256 i; i < n; ++i) {
            Sleeve storage s = _sleeves[i];
            uint160 from = s.anchor != 0 ? s.anchor : lastPostMark;
            if (s.anchor != 0) s.anchor = 0;
            if (from == 0 || s.liquidity == 0) continue;
            (uint160 lo, uint160 hi) = _bounds(s);
            uint256 loss = EdgeMath.rebalancingLoss(s.liquidity, from, sqrtPost, lo, hi);
            if (loss != 0) _ledgers[i].arbLoss += loss;
        }
    }

    /// @dev Split one swap's LP fee across sleeves from the price path and book it as user or arbitrage fee.
    function _attributeFees(uint160 sqrtBefore, uint160 sqrtAfter, uint24 feePips, bool arb) internal {
        if (sqrtBefore == sqrtAfter) return;
        uint256 n = _sleeves.length;
        for (uint256 i; i < n; ++i) {
            Sleeve storage s = _sleeves[i];
            if (s.liquidity == 0) continue;
            (uint160 lo, uint160 hi) = _bounds(s);
            uint256 fee = EdgeMath.swapFee(s.liquidity, sqrtBefore, sqrtAfter, lo, hi, feePips, sqrtAfter);
            if (fee == 0) continue;
            if (arb) _ledgers[i].arbFees += fee;
            else _ledgers[i].userFees += fee;
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev Priority fee per gas of the current transaction (0 if gas price is below the base fee).
    function _priorityFee() internal view returns (uint256) {
        return tx.gasprice > block.basefee ? tx.gasprice - block.basefee : 0;
    }

    /// @dev The bound pool's current square-root price, or 0 before initialization.
    function _currentSqrtPrice() internal view returns (uint160 sqrtPrice) {
        if (!poolBound) return 0;
        (sqrtPrice,,,) = poolManager.getSlot0(poolKey.toId());
    }

    /// @dev Square-root price bounds of a sleeve's ticks.
    function _bounds(Sleeve storage s) internal view returns (uint160 lo, uint160 hi) {
        lo = TickMath.getSqrtPriceAtTick(s.tickLower);
        hi = TickMath.getSqrtPriceAtTick(s.tickUpper);
    }

    /// @dev Load a sleeve or revert.
    function _sleeve(uint256 sleeveId) internal view returns (Sleeve storage) {
        if (sleeveId >= _sleeves.length) revert UnknownSleeve(sleeveId);
        return _sleeves[sleeveId];
    }

    /// @dev Revert unless the range is ordered, inside TickMath bounds and aligned to the pool's tick spacing.
    function _checkRange(int24 tickLower, int24 tickUpper) internal view {
        int24 spacing = poolKey.tickSpacing;
        if (
            tickLower >= tickUpper || tickLower < TickMath.MIN_TICK || tickUpper > TickMath.MAX_TICK
                || tickLower % spacing != 0 || tickUpper % spacing != 0
        ) revert InvalidRange(tickLower, tickUpper);
    }

    /// @dev Settle a negative caller delta from `counterparty`, or take a positive one to it.
    function _settleOrTake(Currency currency, int128 amount, address counterparty) internal {
        if (amount < 0) {
            // casting to 'uint128' is safe because amount < 0 and a PoolManager delta is never type(int128).min
            // forge-lint: disable-next-line(unsafe-typecast)
            currency.settle(poolManager, counterparty, uint128(-amount), false);
        } else if (amount > 0) {
            // casting to 'uint128' is safe because amount > 0
            // forge-lint: disable-next-line(unsafe-typecast)
            currency.take(poolManager, counterparty, uint128(amount), false);
        }
    }
}
