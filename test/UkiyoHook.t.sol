// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {V4PoolManagerDeployer} from "hookmate/artifacts/V4PoolManager.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint128} from "@uniswap/v4-core/src/libraries/FixedPoint128.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import {UkiyoHook} from "../src/UkiyoHook.sol";
import {EdgeMath} from "../src/libraries/EdgeMath.sol";

/// @notice End-to-end tests of the Ukiyo meter against the canonical PoolManager bytecode.
contract UkiyoHookTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint160 internal constant SQRT_PRICE_1_1 = 79_228_162_514_264_337_593_543_950_336;
    uint24 internal constant FEE = 3000; // 30 bps
    int24 internal constant SPACING = 60;
    uint256 internal constant BASE_FEE = 1 gwei;
    uint256 internal constant THRESHOLD = 1 gwei; // priority fee per gas at or above which a swap is arbitrage
    uint256 internal constant ARB_TIP = 5 gwei;
    uint256 internal constant USER_TIP = 0.01 gwei;
    uint128 internal constant LIQ = 1e21;

    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
    );

    IPoolManager internal manager;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal lpRouter;
    UkiyoHook internal hook;
    PoolKey internal key;
    PoolId internal poolId;
    MockERC20 internal token0;
    MockERC20 internal token1;

    address internal stranger = makeAddr("stranger");

    // ------------------------------------------------------------------------------------------------------------
    // Setup
    // ------------------------------------------------------------------------------------------------------------

    function setUp() public {
        manager = IPoolManager(V4PoolManagerDeployer.deploy(address(this)));
        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);

        MockERC20 a = new MockERC20("Token A", "A", 18);
        MockERC20 b = new MockERC20("Token B", "B", 18);
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
        token0.mint(address(this), 1e30);
        token1.mint(address(this), 1e30);

        hook = _deployHook(0x4444);
        key = _key(hook, FEE);
        poolId = key.toId();
        manager.initialize(key, SQRT_PRICE_1_1);

        for (uint256 i; i < 3; ++i) {
            address spender = i == 0 ? address(swapRouter) : i == 1 ? address(lpRouter) : address(hook);
            token0.approve(spender, type(uint256).max);
            token1.approve(spender, type(uint256).max);
        }

        // Two curators: a tight sleeve (about +-6%) and a wide one (about +-45%).
        hook.openSleeve(makeAddr("tight curator"), -600, 600);
        hook.openSleeve(makeAddr("wide curator"), -6000, 6000);
        hook.modifySleeveLiquidity(0, int256(uint256(LIQ)));
        hook.modifySleeveLiquidity(1, int256(uint256(LIQ)));

        vm.fee(BASE_FEE);
    }

    function _deployHook(uint160 namespace) internal returns (UkiyoHook h) {
        address target = address(HOOK_FLAGS | (namespace << 144));
        deployCodeTo("UkiyoHook.sol:UkiyoHook", abi.encode(manager, address(this), THRESHOLD), target);
        h = UkiyoHook(target);
    }

    function _key(UkiyoHook h, uint24 fee) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            fee: fee,
            tickSpacing: SPACING,
            hooks: IHooks(address(h))
        });
    }

    // ------------------------------------------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------------------------------------------

    function _price() internal view returns (uint160 s) {
        (s,,,) = manager.getSlot0(poolId);
    }

    function _nextBlock() internal {
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// @dev Exact-input swap that stops exactly at `target`, paying `tip` wei of priority fee per gas.
    function _swapTo(uint160 target, uint256 tip) internal {
        vm.txGasPrice(BASE_FEE + tip);
        bool zeroForOne = target < _price();
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -1e27, sqrtPriceLimitX96: target}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        assertEq(_price(), target, "swap did not reach target");
    }

    function _atTick(int24 t) internal pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(t);
    }

    function _bounds(uint256 id) internal view returns (uint160 lo, uint160 hi) {
        UkiyoHook.Sleeve memory s = hook.sleeve(id);
        return (_atTick(s.tickLower), _atTick(s.tickUpper));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Binding and access control
    // ------------------------------------------------------------------------------------------------------------

    function test_bindsToTheFirstPoolOnly() public {
        assertTrue(hook.poolBound());
        vm.expectRevert();
        manager.initialize(_key(hook, 500), SQRT_PRICE_1_1);
    }

    function test_refusesDynamicFeePools() public {
        UkiyoHook other = _deployHook(0x5555);
        vm.expectRevert();
        manager.initialize(_key(other, LPFeeLibrary.DYNAMIC_FEE_FLAG), SQRT_PRICE_1_1);
    }

    function test_onlyHookCanAddLiquidity() public {
        vm.expectRevert();
        lpRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e18, salt: 0}), ""
        );
    }

    function test_adminFunctionsAreOwnerOnly() public {
        vm.startPrank(stranger);
        vm.expectRevert();
        hook.openSleeve(stranger, -60, 60);
        vm.expectRevert();
        hook.modifySleeveLiquidity(0, 1);
        vm.expectRevert();
        hook.setSleeveRange(0, -60, 60);
        vm.expectRevert();
        hook.setPriorityFeeThreshold(0);
        vm.stopPrank();
    }

    function test_thresholdRaisesWaitAndLoweringIsImmediate() public {
        uint256 t0 = hook.priorityFeeThreshold();
        hook.setPriorityFeeThreshold(t0 * 10);
        assertEq(hook.priorityFeeThreshold(), t0, "a raise does not apply at once");
        uint256 at = hook.pendingThresholdAt();
        assertEq(at, block.timestamp + hook.THRESHOLD_RAISE_DELAY());
        vm.expectRevert(abi.encodeWithSelector(UkiyoHook.ThresholdNotReady.selector, at));
        hook.applyPriorityFeeThreshold();

        vm.warp(at);
        vm.prank(stranger); // anyone can apply it once due
        hook.applyPriorityFeeThreshold();
        assertEq(hook.priorityFeeThreshold(), t0 * 10);
        vm.expectRevert(UkiyoHook.NoPendingThreshold.selector);
        hook.applyPriorityFeeThreshold();

        // lowering is immediate and cancels a queued raise
        hook.setPriorityFeeThreshold(t0 * 100);
        hook.setPriorityFeeThreshold(1);
        assertEq(hook.priorityFeeThreshold(), 1);
        assertEq(hook.pendingThresholdAt(), 0, "queued raise cancelled");
    }

    function test_rejectsBadRanges() public {
        vm.expectRevert(abi.encodeWithSelector(UkiyoHook.InvalidRange.selector, int24(60), int24(-60)));
        hook.openSleeve(stranger, 60, -60);
        vm.expectRevert(abi.encodeWithSelector(UkiyoHook.InvalidRange.selector, int24(-61), int24(60)));
        hook.openSleeve(stranger, -61, 60);
    }

    function test_capsSleevesAtEight() public {
        for (uint256 i = hook.sleeveCount(); i < hook.MAX_SLEEVES(); ++i) {
            hook.openSleeve(stranger, -60, 60);
        }
        vm.expectRevert(UkiyoHook.TooManySleeves.selector);
        hook.openSleeve(stranger, -60, 60);
    }

    function test_rangeChangeRequiresEmptySleeve() public {
        vm.expectRevert(abi.encodeWithSelector(UkiyoHook.SleeveNotEmpty.selector, 0));
        hook.setSleeveRange(0, -1200, 1200);
    }

    function test_removingLiquidityReturnsTokens() public {
        uint256 b0 = token0.balanceOf(address(this));
        uint256 b1 = token1.balanceOf(address(this));
        hook.modifySleeveLiquidity(0, -int256(uint256(LIQ)));
        assertGt(token0.balanceOf(address(this)), b0);
        assertGt(token1.balanceOf(address(this)), b1);
        assertEq(hook.sleeve(0).liquidity, 0);
    }

    /// @dev Vaults value themselves with `sleeveAmounts`, so it must equal what a full withdrawal pays, fees aside.
    function test_sleeveAmountsMatchAFullWithdrawal() public {
        _swapTo(_atTick(200), USER_TIP); // off-centre, so the two amounts differ
        vm.roll(vm.getBlockNumber() + 1);
        hook.modifySleeveLiquidity(0, 0); // collect fees first, so the withdrawal below is principal only
        (uint256 a0, uint256 a1) = hook.sleeveAmounts(0);
        uint256 b0 = token0.balanceOf(address(this));
        uint256 b1 = token1.balanceOf(address(this));
        hook.modifySleeveLiquidity(0, -int256(uint256(LIQ)));
        assertEq(token0.balanceOf(address(this)) - b0, a0);
        assertEq(token1.balanceOf(address(this)) - b1, a1);
        (a0, a1) = hook.sleeveAmounts(0);
        assertEq(a0 + a1, 0, "empty sleeve holds nothing");
        assertEq(hook.sqrtPriceX96(), _atTick(200));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Classification and fee attribution
    // ------------------------------------------------------------------------------------------------------------

    function test_classifiesByPriorityFee() public {
        vm.txGasPrice(BASE_FEE + ARB_TIP);
        assertTrue(hook.isArbitrage());
        vm.txGasPrice(BASE_FEE + USER_TIP);
        assertFalse(hook.isArbitrage());
        vm.txGasPrice(BASE_FEE + THRESHOLD);
        assertTrue(hook.isArbitrage(), "at the threshold counts as arbitrage");
    }

    function test_arbitrageFeesNeverCountTowardEdge() public {
        _swapTo(_atTick(120), ARB_TIP);
        UkiyoHook.Ledger memory l = hook.ledger(0);
        assertGt(l.arbFees, 0);
        assertEq(l.userFees, 0);
    }

    function test_userFeesCount() public {
        _swapTo(_atTick(-120), USER_TIP);
        UkiyoHook.Ledger memory l = hook.ledger(0);
        assertGt(l.userFees, 0);
        assertEq(l.arbFees, 0);
    }

    /// @notice The hook's price-path fee attribution matches the PoolManager's own fee growth for each sleeve.
    function test_feeAttributionMatchesPoolManager() public {
        uint160[4] memory targets = [_atTick(300), _atTick(-200), _atTick(900), _atTick(-1500)];
        for (uint256 k; k < targets.length; ++k) {
            uint256[2] memory before0;
            uint256[2] memory before1;
            uint256[2] memory userBefore;
            for (uint256 i; i < 2; ++i) {
                UkiyoHook.Sleeve memory s = hook.sleeve(i);
                (before0[i], before1[i]) = manager.getFeeGrowthInside(poolId, s.tickLower, s.tickUpper);
                userBefore[i] = hook.ledger(i).userFees;
            }
            _swapTo(targets[k], USER_TIP);
            uint160 sAfter = _price();
            for (uint256 i; i < 2; ++i) {
                UkiyoHook.Sleeve memory s = hook.sleeve(i);
                (uint256 g0, uint256 g1) = manager.getFeeGrowthInside(poolId, s.tickLower, s.tickUpper);
                uint256 f0 = FullMath.mulDiv(g0 - before0[i], s.liquidity, FixedPoint128.Q128);
                uint256 f1 = FullMath.mulDiv(g1 - before1[i], s.liquidity, FixedPoint128.Q128);
                uint256 expected = EdgeMath.token0ToToken1(f0, sAfter) + f1;
                uint256 got = hook.ledger(i).userFees - userBefore[i];
                // PoolManager rounds each step's fee up; the hook rounds down. Allow 0.01% plus a few wei.
                assertApproxEqAbs(got, expected, expected / 1e4 + 10, "fee attribution drifted from PoolManager");
            }
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Marks, arbitrage loss and user impact
    // ------------------------------------------------------------------------------------------------------------

    function test_firstSwapOfBlockSetsTheMark() public {
        _swapTo(_atTick(60), ARB_TIP);
        assertEq(hook.lastPostMark(), _atTick(60));
        assertEq(hook.lastMarkedBlock(), block.number);
        // A second swap in the same block does not move the mark.
        _swapTo(_atTick(180), USER_TIP);
        assertEq(hook.lastPostMark(), _atTick(60));
    }

    function test_firstMarkChargesLossSinceTheSleeveOpened() public {
        _swapTo(_atTick(60), ARB_TIP);
        for (uint256 i; i < 2; ++i) {
            (uint160 lo, uint160 hi) = _bounds(i);
            assertEq(hook.ledger(i).arbLoss, EdgeMath.rebalancingLoss(LIQ, SQRT_PRICE_1_1, _atTick(60), lo, hi));
            assertEq(hook.sleeve(i).anchor, 0, "anchors consumed by the first mark");
        }
    }

    function test_arbitrageLossBetweenConsecutiveMarks() public {
        _swapTo(_atTick(60), ARB_TIP);
        uint160 m1 = hook.lastPostMark();
        uint256[2] memory before = [hook.ledger(0).arbLoss, hook.ledger(1).arbLoss];
        _nextBlock();
        _swapTo(_atTick(240), ARB_TIP);
        uint160 m2 = hook.lastPostMark();

        for (uint256 i; i < 2; ++i) {
            (uint160 lo, uint160 hi) = _bounds(i);
            uint256 expected = EdgeMath.rebalancingLoss(LIQ, m1, m2, lo, hi);
            assertEq(hook.ledger(i).arbLoss - before[i], expected);
            assertGt(expected, 0);
        }
    }

    function test_userImpactCreditedOnNextBlock() public {
        _swapTo(_atTick(60), ARB_TIP); // s* of block 1
        _swapTo(_atTick(-300), USER_TIP); // users push the price away
        assertEq(hook.ledger(0).userImpact, 0, "impact must wait for the block to close");

        _nextBlock();
        _swapTo(_atTick(0), ARB_TIP); // first swap of block 2 credits block 1's impact

        for (uint256 i; i < 2; ++i) {
            (uint160 lo, uint160 hi) = _bounds(i);
            uint256 expected = EdgeMath.impactCredit(hook.sleeve(i).liquidity, _atTick(60), _atTick(-300), lo, hi);
            assertEq(hook.ledger(i).userImpact, expected);
            assertGt(expected, 0);
        }
    }

    /// @notice A same-block buy and sell earns fees for LPs but no impact credit: Edge cannot be pumped by round trips.
    function test_sameBlockRoundTripEarnsNoImpact() public {
        _swapTo(_atTick(60), ARB_TIP);
        _swapTo(_atTick(1200), USER_TIP);
        _swapTo(_atTick(60), USER_TIP); // back to the mark
        _nextBlock();
        _swapTo(_atTick(60 + SPACING), ARB_TIP);

        assertEq(hook.ledger(0).userImpact, 0);
        assertEq(hook.ledger(1).userImpact, 0);
        assertGt(hook.ledger(0).userFees, 0, "the round trip still paid real fees");
    }

    function test_blocksWithoutSwapsAreSkipped() public {
        _swapTo(_atTick(60), ARB_TIP);
        uint160 m1 = hook.lastPostMark();
        uint256 before = hook.ledger(0).arbLoss;
        vm.roll(block.number + 50);
        _swapTo(_atTick(-60), ARB_TIP);
        (uint160 lo, uint160 hi) = _bounds(0);
        assertEq(hook.ledger(0).arbLoss - before, EdgeMath.rebalancingLoss(LIQ, m1, _atTick(-60), lo, hi));
    }

    function test_edgeIsFeesPlusImpactMinusLoss() public {
        _swapTo(_atTick(60), ARB_TIP);
        _swapTo(_atTick(-240), USER_TIP);
        _nextBlock();
        _swapTo(_atTick(30 * 2), ARB_TIP);
        _swapTo(_atTick(-600), USER_TIP);
        _nextBlock();
        _swapTo(_atTick(0), ARB_TIP);

        for (uint256 i; i < 2; ++i) {
            UkiyoHook.Ledger memory l = hook.ledger(i);
            assertEq(hook.edge(i), int256(l.userFees + l.userImpact) - int256(l.arbLoss));
        }
    }

    /// @notice A re-ranged sleeve is measured from the price at which it changed, not from the older global mark.
    function test_rangeChangeAnchorsTheSleeve() public {
        _swapTo(_atTick(60), ARB_TIP);
        _nextBlock();
        _swapTo(_atTick(300), ARB_TIP);

        // Curator empties the tight sleeve and re-centres it mid-block at the current price.
        hook.modifySleeveLiquidity(0, -int256(uint256(LIQ)));
        hook.setSleeveRange(0, 0, 600);
        uint160 anchor = _price();
        hook.modifySleeveLiquidity(0, int256(uint256(LIQ)));
        uint256 lossBefore = hook.ledger(0).arbLoss;

        _nextBlock();
        _swapTo(_atTick(420), ARB_TIP);
        (uint160 lo, uint160 hi) = _bounds(0);
        uint256 expected = EdgeMath.rebalancingLoss(LIQ, anchor, _atTick(420), lo, hi);
        assertEq(hook.ledger(0).arbLoss - lossBefore, expected);
        assertEq(hook.sleeve(0).anchor, 0, "anchor is consumed by the next mark");
    }

    /// @notice The reference price is a mark the current transaction cannot have set: within a marked block, the
    ///         block before's; in a new block before any swap, the latest mark.
    function test_referencePriceIsAMarkThisTransactionCannotSet() public {
        _swapTo(_atTick(60), ARB_TIP);
        uint160 first = hook.lastPostMark();
        _nextBlock();
        assertEq(hook.referenceSqrtPrice(), first, "new block, no swap yet: the latest mark");
        _swapTo(_atTick(900), ARB_TIP); // this block's mark, which a manipulator could have set
        assertEq(hook.lastPostMark(), _atTick(900));
        assertEq(hook.prevPostMark(), first);
        assertEq(hook.referenceSqrtPrice(), first, "within the block: the mark before it");
    }

    /// @notice Liquidity added after users moved the price is not credited for that move. Before anchoring, a vault
    ///         settling a large deposit right after user flow had its whole new liquidity credited with the block's
    ///         impact, overstating Edge.
    function test_addedLiquidityIsMeasuredFromWhereItJoined() public {
        _swapTo(_atTick(60), ARB_TIP); // s* of this block
        _swapTo(_atTick(-300), USER_TIP); // users push the price away
        uint160 joined = _price();
        uint256 impactBefore = hook.ledger(0).userImpact;
        uint256 lossBefore = hook.ledger(0).arbLoss;
        hook.modifySleeveLiquidity(0, int256(uint256(10 * LIQ))); // a deposit lands mid-block
        assertEq(hook.sleeve(0).anchoredLiquidity, 10 * LIQ);
        assertEq(hook.sleeve(0).anchor, joined);

        _nextBlock();
        _swapTo(_atTick(60), ARB_TIP); // arbitrage reverts the push

        (uint160 lo, uint160 hi) = _bounds(0);
        uint256 impact = hook.ledger(0).userImpact - impactBefore;
        uint256 loss = hook.ledger(0).arbLoss - lossBefore;
        // the old liquidity saw the push; the new liquidity only saw the reversal
        assertEq(
            impact, EdgeMath.impactCredit(LIQ, _atTick(60), joined, lo, hi), "impact only for liquidity that saw it"
        );
        assertEq(
            loss, EdgeMath.rebalancingLoss(10 * LIQ, joined, _atTick(60), lo, hi), "new liquidity pays the reversal"
        );
        assertLt(impact, EdgeMath.impactCredit(11 * LIQ, _atTick(60), joined, lo, hi), "no credit for unseen impact");
        assertEq(hook.sleeve(0).anchoredLiquidity, 0, "the mark makes it ordinary liquidity");
        assertEq(hook.sleeve(0).anchor, 0);
    }

    /// @notice Removal takes the newest liquidity first, and removing all of it drops the anchor.
    function test_removalTakesAnchoredLiquidityFirst() public {
        _swapTo(_atTick(60), ARB_TIP);
        hook.modifySleeveLiquidity(1, int256(uint256(LIQ)));
        hook.modifySleeveLiquidity(1, -int256(uint256(LIQ / 2)));
        assertEq(hook.sleeve(1).anchoredLiquidity, LIQ / 2);
        assertEq(hook.sleeve(1).liquidity, LIQ + LIQ / 2);
        hook.modifySleeveLiquidity(1, -int256(uint256(LIQ)));
        assertEq(hook.sleeve(1).anchoredLiquidity, 0);
        assertEq(hook.sleeve(1).anchor, 0, "nothing left to anchor");
        assertEq(hook.sleeve(1).liquidity, LIQ / 2);
    }

    /// @notice With a protocol fee switched on, the hook still matches the PoolManager's own LP fee growth.
    function test_feeAttributionMatchesPoolManagerWithProtocolFee() public {
        manager.setProtocolFeeController(address(this));
        manager.setProtocolFee(key, (uint24(700) << 12) | 1000); // 0.07% one way, 0.1% the other
        test_feeAttributionMatchesPoolManager();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Gas (run with `forge test --match-test test_gas -vv`; `--gas-report` isolates calls and drops tx.gasprice)
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Gas of a block's first swap (marks + loss + impact for 2 sleeves) and of a later swap in the block.
    function test_gas_swapPath() public {
        _swapTo(_atTick(60), ARB_TIP);
        _swapTo(_atTick(-120), USER_TIP);
        _nextBlock();

        vm.txGasPrice(BASE_FEE + ARB_TIP);
        uint256 g = gasleft();
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -1e27, sqrtPriceLimitX96: _atTick(180)}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        uint256 firstSwap = g - gasleft();

        vm.txGasPrice(BASE_FEE + USER_TIP);
        g = gasleft();
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -1e27, sqrtPriceLimitX96: _atTick(0)}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        uint256 laterSwap = g - gasleft();

        emit log_named_uint("gas: first swap of a block (2 sleeves)", firstSwap);
        emit log_named_uint("gas: later swap in the same block (2 sleeves)", laterSwap);
        assertLt(firstSwap, 400_000);
        assertLt(laterSwap, 300_000);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Differential fuzz: the hook's ledgers equal an independent replay of the same price path
    // ------------------------------------------------------------------------------------------------------------

    struct Ref {
        uint256 userFees;
        uint256 arbFees;
        uint256 impact;
        uint256 loss;
        uint128 liquidity;
        uint128 anchored;
        uint160 anchor;
    }

    /// @dev Reference-model state, kept in storage to stay clear of the stack limit.
    Ref[2] internal ref;
    uint160 internal refMark;
    bool internal refPending;
    uint16[2] internal refProtocolFee; // [zeroForOne, oneForZero]

    /// @notice Random blocks of random swaps, with liquidity added and removed at random points and a random protocol
    ///         fee; every ledger field must equal a straightforward reference replay.
    function testFuzz_ledgersMatchReferenceReplay(uint256 seed) public {
        // setUp added both sleeves' liquidity before the pool's first mark: all of it anchored at the initial price
        for (uint256 i; i < 2; ++i) {
            ref[i].liquidity = LIQ;
            ref[i].anchored = LIQ;
            ref[i].anchor = _price();
        }
        if (seed % 3 == 0) {
            // casting to 'uint16' is safe because both values are at most 1000
            // forge-lint: disable-next-line(unsafe-typecast)
            refProtocolFee = [uint16((seed >> 8) % 1001), uint16((seed >> 24) % 1001)];
            manager.setProtocolFeeController(address(this));
            manager.setProtocolFee(key, (uint24(refProtocolFee[1]) << 12) | refProtocolFee[0]);
        }
        uint256 blocks = 2 + seed % 5;
        for (uint256 b; b < blocks; ++b) {
            _nextBlock();
            uint256 swaps = 1 + uint256(keccak256(abi.encode(seed, b))) % 3;
            for (uint256 k; k < swaps; ++k) {
                uint256 r = uint256(keccak256(abi.encode(seed, b, k)));
                if ((r >> 200) % 4 == 0) _refLiquidity(r);
                _refSwap(r, k == 0);
            }
        }
        for (uint256 i; i < 2; ++i) {
            UkiyoHook.Ledger memory l = hook.ledger(i);
            assertEq(l.userFees, ref[i].userFees, "userFees");
            assertEq(l.arbFees, ref[i].arbFees, "arbFees");
            assertEq(l.userImpact, ref[i].impact, "userImpact");
            assertEq(l.arbLoss, ref[i].loss, "arbLoss");
            assertEq(hook.sleeve(i).liquidity, ref[i].liquidity, "liquidity");
        }
    }

    /// @dev Add or remove a random amount of one sleeve's liquidity, in the pool and in the reference model.
    function _refLiquidity(uint256 r) internal {
        uint256 i = (r >> 202) % 2;
        Ref storage m = ref[i];
        bool add = m.liquidity == 0 || (r >> 204) % 2 == 0;
        // casting to 'uint128' is safe because the value is at most LIQ or the sleeve's liquidity
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 amount = uint128(1 + (r >> 64) % (add ? LIQ : m.liquidity));
        if (add) {
            hook.modifySleeveLiquidity(i, int256(uint256(amount)));
            m.liquidity += amount;
            m.anchored += amount;
            m.anchor = _price();
        } else {
            hook.modifySleeveLiquidity(i, -int256(uint256(amount)));
            m.liquidity -= amount;
            if (m.anchored != 0) {
                m.anchored = m.anchored > amount ? m.anchored - amount : 0;
                if (m.anchored == 0) m.anchor = 0;
            }
        }
    }

    /// @dev One random swap, applied to the pool and to the reference model.
    function _refSwap(uint256 r, bool firstInBlock) internal {
        // casting to 'int24' is safe because r % 101 is at most 100
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 tick = int24(int256(r % 101)) * SPACING - 50 * SPACING; // [-3000, 3000]
        uint160 target = _atTick(tick);
        uint160 before = _price();
        if (target == before) target = _atTick(tick + SPACING);
        bool arb = (r >> 128) % 2 == 0;

        // The previous marked block closed at `before`: credit its impact first, as the hook does.
        if (firstInBlock && refPending) {
            for (uint256 i; i < 2; ++i) {
                Ref storage m = ref[i];
                if (m.liquidity == 0) continue;
                (uint160 lo, uint160 hi) = _bounds(i);
                if (m.liquidity > m.anchored) {
                    m.impact += EdgeMath.impactCredit(m.liquidity - m.anchored, refMark, before, lo, hi);
                }
                if (m.anchored != 0) m.impact += EdgeMath.impactCredit(m.anchored, m.anchor, before, lo, hi);
            }
        }

        _swapTo(target, arb ? ARB_TIP : USER_TIP);

        (uint256 num, uint256 den) = EdgeMath.lpFeeRate(FEE, refProtocolFee[target < before ? 0 : 1]);
        for (uint256 i; i < 2; ++i) {
            Ref storage m = ref[i];
            (uint160 lo, uint160 hi) = _bounds(i);
            uint256 fee = m.liquidity == 0 ? 0 : EdgeMath.swapFee(m.liquidity, before, target, lo, hi, num, den);
            if (arb) m.arbFees += fee;
            else m.userFees += fee;
            if (firstInBlock) {
                if (m.liquidity > m.anchored && refMark != 0) {
                    m.loss += EdgeMath.rebalancingLoss(m.liquidity - m.anchored, refMark, target, lo, hi);
                }
                if (m.liquidity != 0 && m.anchored != 0) {
                    m.loss += EdgeMath.rebalancingLoss(m.anchored, m.anchor, target, lo, hi);
                }
                m.anchored = 0;
                m.anchor = 0;
            }
        }
        if (firstInBlock) {
            refMark = target;
            refPending = true;
        }
    }
}
