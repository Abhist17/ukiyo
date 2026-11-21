// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {V4PoolManagerDeployer} from "hookmate/artifacts/V4PoolManager.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {UkiyoHook} from "../src/UkiyoHook.sol";
import {UkiyoVault} from "../src/UkiyoVault.sol";

/// @notice Curator vault tests against the canonical PoolManager bytecode, on a 5 bps pool.
contract UkiyoVaultTest is Test {
    uint160 internal constant SQRT_PRICE_1_1 = 79_228_162_514_264_337_593_543_950_336;
    uint24 internal constant FEE = 500;
    int24 internal constant SPACING = 10;
    uint256 internal constant BASE_FEE = 1 gwei;
    uint256 internal constant THRESHOLD = 1 gwei;
    uint256 internal constant USER_TIP = 0.01 gwei;
    uint256 internal constant EPOCH = 1 days;
    uint256 internal constant FEE_BPS = 1000; // 10% of Edge above the high-water mark

    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
    );

    IPoolManager internal manager;
    PoolSwapTest internal swapRouter;
    UkiyoHook internal hook;
    UkiyoVault internal vault;
    PoolKey internal key;
    MockERC20 internal token0;
    MockERC20 internal token1;

    address internal curator = makeAddr("curator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        manager = IPoolManager(V4PoolManagerDeployer.deploy(address(this)));
        swapRouter = new PoolSwapTest(manager);

        MockERC20 a = new MockERC20("Token A", "A", 18);
        MockERC20 b = new MockERC20("Token B", "B", 18);
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
        token0.mint(address(this), 1e30);
        token1.mint(address(this), 1e30);
        token0.approve(address(swapRouter), type(uint256).max);
        token1.approve(address(swapRouter), type(uint256).max);

        address target = address(HOOK_FLAGS | (uint160(0x4444) << 144));
        deployCodeTo("UkiyoHook.sol:UkiyoHook", abi.encode(manager, address(this), THRESHOLD), target);
        hook = UkiyoHook(target);
        key = PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(target)
        });
        manager.initialize(key, SQRT_PRICE_1_1);

        hook.openSleeve(curator, -1000, 1000); // about +-10%
        vault = new UkiyoVault(hook, 0, curator, EPOCH, FEE_BPS, "Ukiyo curator vault", "uCV");
        hook.setSleeveManager(0, address(vault));

        _fund(alice);
        _fund(bob);
        vm.fee(BASE_FEE);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------------------------------------------

    function _fund(address user) internal {
        token0.mint(user, 1e30);
        token1.mint(user, 1e30);
        vm.startPrank(user);
        token0.approve(address(vault), type(uint256).max);
        token1.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function _deposit(address user, uint256 a0, uint256 a1) internal {
        vm.prank(user);
        vault.requestDeposit(a0, a1);
    }

    function _settle() internal {
        vm.warp(vault.epochEndsAt());
        vm.roll(vm.getBlockNumber() + 1);
        vault.settleEpoch();
    }

    /// @dev Exact-input user swap of `amount` of token0 (zeroForOne) or token1.
    function _swap(bool zeroForOne, uint256 amount) internal {
        vm.txGasPrice(BASE_FEE + USER_TIP);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Exact-input arbitrage swap: pays a priority fee at the threshold, so the hook books it as arbitrage.
    function _arb(bool zeroForOne, uint256 amount) internal {
        vm.txGasPrice(BASE_FEE + THRESHOLD);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Blocks of arbitrage pushing the price down and back up: pure arbitrage loss, so the epoch's Edge is negative.
    function _losingEpoch() internal {
        for (uint256 i; i < 3; ++i) {
            vm.roll(vm.getBlockNumber() + 1);
            _arb(true, 2e18);
            vm.roll(vm.getBlockNumber() + 1);
            _arb(false, 2e18);
        }
    }

    /// @dev Blocks of user round trips: fees and no lasting move, so the epoch's Edge is positive.
    function _winningEpoch() internal {
        for (uint256 i; i < 5; ++i) {
            vm.roll(vm.getBlockNumber() + 1);
            _swap(true, 1e18);
            _swap(false, 1e18);
        }
    }

    /// @dev Edge the sleeve has earned since the current epoch started.
    function _epochEdge() internal view returns (int256) {
        return hook.edge(0) - vault.epochStartEdge();
    }

    /// @dev Curator posts `amount` of token1 as bond.
    function _postBond(uint256 amount) internal {
        token1.mint(curator, amount);
        vm.startPrank(curator);
        token1.approve(address(vault), amount);
        vault.postBond(amount);
        vm.stopPrank();
    }

    /// @dev Another sleeve, run by the hook owner (this test), so the vault's own swaps have liquidity to trade against.
    function _backgroundLiquidity(uint128 l) internal {
        hook.openSleeve(address(this), -3000, 3000);
        token0.approve(address(hook), type(uint256).max);
        token1.approve(address(hook), type(uint256).max);
        hook.modifySleeveLiquidity(1, int256(uint256(l)));
    }

    function _liquidity() internal view returns (uint128) {
        return hook.sleeve(0).liquidity;
    }

    /// @dev The vault never owes more than it holds.
    function _assertSolvent() internal view {
        (uint256 r0, uint256 r1) = vault.reserved();
        assertGe(token0.balanceOf(address(vault)), r0, "token0 below reserved");
        assertGe(token1.balanceOf(address(vault)), r1 + vault.bond(), "token1 below reserved plus bond");
    }

    // ------------------------------------------------------------------------------------------------------------
    // Hand-over and access control
    // ------------------------------------------------------------------------------------------------------------

    function test_managerIsSetOnceAndLocksOutTheOwner() public {
        assertEq(hook.sleeveManager(0), address(vault));
        assertTrue(hook.isSleeveManager(address(vault)), "registered as a manager");
        vm.expectRevert(abi.encodeWithSelector(UkiyoHook.InvalidSleeveManager.selector, 0));
        hook.setSleeveManager(0, address(this));
        vm.expectRevert(abi.encodeWithSelector(UkiyoHook.NotSleeveController.selector, 0, address(this)));
        hook.modifySleeveLiquidity(0, -1);
        vm.expectRevert(abi.encodeWithSelector(UkiyoHook.NotSleeveController.selector, 0, address(this)));
        hook.setSleeveRange(0, -100, 100);
    }

    function test_onlyOwnerHandsOverSleeves() public {
        hook.openSleeve(curator, -100, 100);
        vm.prank(stranger);
        vm.expectRevert();
        hook.setSleeveManager(1, stranger);
        vm.expectRevert(abi.encodeWithSelector(UkiyoHook.InvalidSleeveManager.selector, 1));
        hook.setSleeveManager(1, address(0));
    }

    function test_onlyCuratorRebalances() public {
        vm.prank(stranger);
        vm.expectRevert(UkiyoVault.NotCurator.selector);
        vault.rebalance(-500, 500);
    }

    function test_constructorChecks() public {
        vm.expectRevert(UkiyoVault.ZeroCurator.selector);
        new UkiyoVault(hook, 0, address(0), EPOCH, 0, "x", "x");
    }

    // ------------------------------------------------------------------------------------------------------------
    // Epochs, deposits and redemptions
    // ------------------------------------------------------------------------------------------------------------

    function test_cannotSettleBeforeTheEpochEnds() public {
        vm.expectRevert(abi.encodeWithSelector(UkiyoVault.EpochNotOver.selector, vault.epochEndsAt()));
        vault.settleEpoch();
    }

    function test_depositsWaitForTheEpochBoundary() public {
        _deposit(alice, 1e18, 1e18);
        assertEq(vault.balanceOf(alice), 0, "no shares before settlement");
        assertEq(_liquidity(), 0, "nothing deployed before settlement");
        (uint256 h0, uint256 h1) = vault.holdings();
        assertEq(h0 + h1, 0, "escrow is not capital");
    }

    function test_firstDepositMintsLiquidityAsShares() public {
        _deposit(alice, 1e18, 1e18);
        _settle();
        uint128 liq = _liquidity();
        assertGt(liq, 0);
        assertEq(vault.totalSupply(), liq, "first shares equal the liquidity added");
        assertEq(vault.balanceOf(alice), liq - vault.DEAD_SHARES());
        assertEq(vault.epoch(), 1);
        // At 1:1 in a symmetric range both tokens fit, so the refund is at most rounding dust.
        (uint256 r0, uint256 r1) = vault.refunds(alice);
        assertLe(r0 + r1, 2);
        _assertSolvent();
    }

    function test_tooSmallFirstDepositIsRefunded() public {
        _deposit(alice, 10, 10);
        _settle();
        assertEq(vault.totalSupply(), 0);
        (uint256 r0, uint256 r1) = vault.refunds(alice);
        assertEq(r0, 10);
        assertEq(r1, 10);
        uint256 before = token0.balanceOf(alice);
        vm.prank(alice);
        vault.claimRefund();
        assertEq(token0.balanceOf(alice) - before, 10);
    }

    function test_laterDepositsBuyTheVaultsRatio() public {
        _deposit(alice, 1e18, 1e18);
        _settle();
        // Bob brings twice Alice's token0 but five times her token1: token0 limits him, token1 is refunded.
        _deposit(bob, 2e18, 5e18);
        _settle();
        assertApproxEqRel(vault.balanceOf(bob), 2 * vault.balanceOf(alice), 1e12, "proportional shares");
        (, uint256 r1) = vault.refunds(bob);
        assertApproxEqRel(r1, 3e18, 1e12, "unused token1 refunded");
        _assertSolvent();
    }

    function test_dustCannotFillTheQueue() public {
        _deposit(alice, 10e18, 10e18);
        _settle();
        (uint256 h0, uint256 h1) = vault.holdings();
        vm.prank(bob);
        vm.expectRevert(UkiyoVault.DepositTooSmall.selector);
        vault.requestDeposit(h0 / 20_000, h1 / 20_000);
        _deposit(bob, h0 / 10_000 + 1, 0); // one token at the minimum is enough
        _deposit(bob, 1, 1); // and an open request can be topped up by any amount
    }

    function test_cancelReturnsTheEscrow() public {
        _deposit(alice, 1e18, 2e18);
        uint256 before1 = token1.balanceOf(alice);
        vm.prank(alice);
        vault.cancelDeposit();
        assertEq(token1.balanceOf(alice) - before1, 2e18);
        _settle();
        assertEq(vault.totalSupply(), 0);
        (uint256 r0, uint256 r1) = vault.reserved();
        assertEq(r0 + r1, 0);
    }

    function test_depositorsPerEpochAreCapped() public {
        uint256 cap = vault.MAX_DEPOSITORS_PER_EPOCH();
        _deposit(alice, 1e15, 1e15);
        for (uint256 i = 1; i < cap; ++i) {
            address u = address(uint160(0x1000 + i));
            _fund(u);
            _deposit(u, 1e15, 1e15);
        }
        _deposit(alice, 1, 1); // topping up an existing request is still fine; a new requester is not
        address late = makeAddr("late");
        _fund(late);
        vm.prank(late);
        vm.expectRevert(UkiyoVault.EpochFull.selector);
        vault.requestDeposit(1e15, 1e15);
    }

    function test_redemptionPaysItsShareOfTheVault() public {
        _deposit(alice, 1e18, 1e18);
        _deposit(bob, 1e18, 1e18);
        _settle();
        uint128 liqBefore = _liquidity();
        (uint256 h0, uint256 h1) = vault.holdings();
        uint256 supply = vault.totalSupply();
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 half = aliceShares / 2;

        vm.prank(alice);
        vault.requestRedeem(half);
        assertEq(vault.balanceOf(alice), aliceShares - half, "shares escrowed");
        assertEq(vault.balanceOf(address(vault)), half, "held by the vault");
        _settle();

        assertApproxEqAbs(_liquidity(), liqBefore - uint256(liqBefore) * half / supply, 1);
        uint256 before0 = token0.balanceOf(alice);
        uint256 before1 = token1.balanceOf(alice);
        vm.prank(alice);
        vault.claimRedemption(1);
        assertApproxEqAbs(token0.balanceOf(alice) - before0, h0 * half / supply, 3);
        assertApproxEqAbs(token1.balanceOf(alice) - before1, h1 * half / supply, 3);
        assertLe(token0.balanceOf(alice) - before0, h0 * half / supply, "never more than its share");

        vm.prank(alice);
        vm.expectRevert(UkiyoVault.ZeroAmount.selector);
        vault.claimRedemption(1);
        _assertSolvent();
    }

    function test_cannotClaimAnUnsettledEpoch() public {
        _deposit(alice, 1e18, 1e18);
        _settle();
        uint256 shares = vault.balanceOf(alice);
        vm.startPrank(alice);
        vault.requestRedeem(shares);
        vm.expectRevert(abi.encodeWithSelector(UkiyoVault.EpochNotSettled.selector, 1));
        vault.claimRedemption(1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Fees, Edge and the curator
    // ------------------------------------------------------------------------------------------------------------

    function test_feesAccrueToShareholders() public {
        _deposit(alice, 10e18, 10e18);
        _settle();
        (uint256 a0, uint256 a1) = vault.holdings();
        // User round trips: the price ends near where it started and the sleeve keeps the fees.
        for (uint256 i; i < 5; ++i) {
            vm.roll(vm.getBlockNumber() + 1);
            _swap(true, 1e18);
            _swap(false, 1e18);
        }
        _settle(); // collects the fees into the vault
        (uint256 b0, uint256 b1) = vault.holdings();
        assertGt(b0 + b1, a0 + a1, "fees raised the vault's holdings");
        assertGt(hook.ledger(0).userFees, 0, "the hook booked them as user fees");
    }

    function test_settlementRecordsTheEpochsEdge() public {
        _deposit(alice, 10e18, 10e18);
        _settle();
        vm.roll(vm.getBlockNumber() + 1);
        _swap(true, 1e18);
        vm.roll(vm.getBlockNumber() + 1);
        _swap(false, 1e18);
        int256 edge = hook.edge(0);
        assertTrue(edge != vault.epochStartEdge(), "edge moved during the epoch");
        _settle();
        assertEq(vault.epochStartEdge(), hook.edge(0), "next epoch starts from the current edge");
    }

    function test_curatorRebalanceMovesTheSleeve() public {
        _deposit(alice, 1e18, 1e18);
        _settle();
        uint160 price = hook.sqrtPriceX96();
        vm.prank(curator);
        vault.rebalance(-200, 200);
        UkiyoHook.Sleeve memory s = hook.sleeve(0);
        assertEq(s.tickLower, -200);
        assertEq(s.tickUpper, 200);
        assertGt(s.liquidity, 0, "capital redeployed");
        assertEq(s.anchor, price, "new range anchored at the current price");
        (uint256 h0, uint256 h1) = vault.holdings();
        assertApproxEqRel(h0 + h1, 2e18, 1e14, "nothing lost moving the range");
        _assertSolvent();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Rebalancing with a swap
    // ------------------------------------------------------------------------------------------------------------

    function test_rebalanceWithSwapFundsARangeAPlainRebalanceCannot() public {
        _backgroundLiquidity(1e22);
        _deposit(alice, 10e18, 10e18);
        _settle();
        // a range above the price takes only token0; the vault holds half its value in token1
        uint256 snap = vm.snapshotState();
        vm.prank(curator);
        vault.rebalance(200, 1200);
        uint128 plain = _liquidity();
        vm.revertToState(snap);

        vm.roll(vm.getBlockNumber() + 1);
        vm.txGasPrice(BASE_FEE);
        vm.prank(curator);
        vault.rebalanceWithSwap(200, 1200, false, 8e18); // sell token1 for token0
        uint128 swapped = _liquidity();
        assertGt(swapped, plain * 3 / 2, "the swap funded a much larger position");
        (uint256 h0, uint256 h1) = vault.holdings();
        assertApproxEqRel(h0 + h1, 20e18, 0.01e18, "swap cost stays small");
        _assertSolvent();
    }

    function test_vaultSwapIsBookedAsArbitrage() public {
        _backgroundLiquidity(1e22);
        _deposit(alice, 10e18, 10e18);
        _settle();
        UkiyoHook.Ledger memory before = hook.ledger(1);
        vm.roll(vm.getBlockNumber() + 1);
        vm.txGasPrice(BASE_FEE); // no tip at all: by tip alone this would be user flow
        vm.prank(curator);
        vault.rebalanceWithSwap(-500, 500, true, 2e18);
        UkiyoHook.Ledger memory afterSwap = hook.ledger(1);
        assertEq(afterSwap.userFees, before.userFees, "no user fees from a manager's swap");
        assertGt(afterSwap.arbFees, before.arbFees, "its fee is booked as arbitrage");
    }

    function test_rebalanceSwapMovesThePriceAtMostOnePercent() public {
        _backgroundLiquidity(1e19); // shallow: an unbounded swap would move the price far
        _deposit(alice, 10e18, 10e18);
        _settle();
        uint160 p0 = hook.sqrtPriceX96();
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(curator);
        vault.rebalanceWithSwap(-1000, 1000, false, 10e18);
        uint160 p1 = hook.sqrtPriceX96();
        // price = sqrtPrice^2; at most +1% means sqrtPrice at most +0.5%
        assertLe(uint256(p1) * 10_000, uint256(p0) * 10_050, "price move bounded");
        assertGt(p1, p0, "the swap did move the price");
        _assertSolvent();
    }

    function test_onlyCuratorRebalancesWithSwap() public {
        vm.prank(stranger);
        vm.expectRevert(UkiyoVault.NotCurator.selector);
        vault.rebalanceWithSwap(-500, 500, true, 1);
    }

    function test_unlockCallbackOnlyAnswersTheVaultsOwnSwap() public {
        vm.expectRevert(UkiyoVault.NotOwnSwap.selector);
        vault.unlockCallback(abi.encode(true, uint256(1), uint160(1)));
        vm.prank(address(manager));
        vm.expectRevert(UkiyoVault.NotOwnSwap.selector);
        vault.unlockCallback(abi.encode(true, uint256(1), uint160(1)));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Performance fee
    // ------------------------------------------------------------------------------------------------------------

    function test_performanceFeeIsAShareOfPositiveEdge() public {
        _deposit(alice, 10e18, 10e18);
        _settle();
        _winningEpoch();
        int256 earned = _epochEdge();
        assertGt(earned, 0, "a winning epoch");
        _settle();

        uint256 shares = vault.balanceOf(curator);
        assertGt(shares, 0, "curator paid in shares");
        // the shares are worth FEE_BPS of the Edge, at the mark
        uint256 worth = shares * vault.valueAtMark() / vault.totalSupply();
        uint256 due = uint256(earned) * FEE_BPS / 10_000;
        assertApproxEqRel(worth, due, 0.01e18, "fee worth 10% of the epoch's Edge");
        assertLe(worth, due + 2, "never more than earned");
        assertEq(vault.highWaterMark(), vault.edgePerShare(), "high-water mark raised");
    }

    function test_noFeeOnLossesAndLossesMustBeEarnedBack() public {
        _deposit(alice, 10e18, 10e18);
        _settle();
        _losingEpoch();
        assertLt(_epochEdge(), 0, "a losing epoch");
        _settle();
        assertEq(vault.balanceOf(curator), 0, "no fee on a loss");
        assertLt(vault.edgePerShare(), 0);
        assertEq(vault.highWaterMark(), 0, "mark not lowered");

        // a small winning epoch that does not recover the loss pays nothing either
        vm.roll(vm.getBlockNumber() + 1);
        _swap(true, 1e17);
        _swap(false, 1e17);
        assertGt(_epochEdge(), 0);
        _settle();
        assertLt(vault.edgePerShare(), 0, "still under water");
        assertEq(vault.balanceOf(curator), 0, "no fee until the high-water mark is regained");
    }

    function test_constructorCapsTheFee() public {
        vm.expectRevert(abi.encodeWithSelector(UkiyoVault.AboveCap.selector, 2001, 2000));
        new UkiyoVault(hook, 0, curator, EPOCH, 2001, "x", "x");
    }

    // ------------------------------------------------------------------------------------------------------------
    // LVR bond
    // ------------------------------------------------------------------------------------------------------------

    function test_bondPaysTheOvershootToDepositors() public {
        _deposit(alice, 10e18, 10e18);
        _settle(); // budget 0 from the start
        _postBond(1000e18);
        _losingEpoch();
        uint256 loss = uint256(-_epochEdge());
        (, uint256 before1) = vault.holdings();
        _settle();
        assertEq(vault.bond(), 1000e18 - loss, "the whole loss came out of the bond");
        (, uint256 after1) = vault.holdings();
        // collected fees land in holdings too, so depositors gain at least the penalty in token1
        assertGe(after1, before1 + loss - 2, "penalty became depositors' capital");
        _assertSolvent();
    }

    function test_bondPenaltyIsCappedAtTheBond() public {
        _deposit(alice, 10e18, 10e18);
        _settle();
        _postBond(1e9); // far smaller than the epoch's loss
        _losingEpoch();
        assertGt(uint256(-_epochEdge()), 1e9);
        _settle();
        assertEq(vault.bond(), 0, "bond exhausted, never more");
        _assertSolvent();
    }

    function test_lossesWithinTheBudgetCostNothing() public {
        _deposit(alice, 10e18, 10e18);
        vm.prank(curator);
        vault.setLvrBudget(1000); // 10% of value per epoch
        assertEq(vault.lvrBudgetBps(), 0, "budget waits for the next epoch");
        _settle();
        assertEq(vault.lvrBudgetBps(), 1000);
        _postBond(1000e18);
        _losingEpoch();
        _settle();
        assertEq(vault.bond(), 1000e18, "loss inside the budget");
    }

    function test_bondWithdrawalWaitsForSettlementAndPenalty() public {
        _deposit(alice, 10e18, 10e18);
        _settle();
        _postBond(1000e18);
        vm.prank(curator);
        vault.requestBondWithdrawal(1000e18);
        assertEq(token1.balanceOf(curator), 0, "nothing paid yet");
        _losingEpoch();
        uint256 loss = uint256(-_epochEdge());
        _settle();
        assertEq(token1.balanceOf(curator), 1000e18 - loss, "paid what is left after the penalty");
        assertEq(vault.bond(), 0);
        assertEq(vault.bondWithdrawal(), 0);
        _assertSolvent();
    }

    function test_onlyCuratorManagesTheBond() public {
        vm.startPrank(stranger);
        vm.expectRevert(UkiyoVault.NotCurator.selector);
        vault.postBond(1);
        vm.expectRevert(UkiyoVault.NotCurator.selector);
        vault.requestBondWithdrawal(1);
        vm.expectRevert(UkiyoVault.NotCurator.selector);
        vault.setLvrBudget(1);
        vm.stopPrank();
        vm.prank(curator);
        vm.expectRevert(abi.encodeWithSelector(UkiyoVault.AboveCap.selector, 1001, 1000));
        vault.setLvrBudget(1001);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Gas
    // ------------------------------------------------------------------------------------------------------------

    /// @dev Gas of the vault's main paths, measured inside one test transaction (see README on --gas-report).
    function test_gas_vaultPaths() public {
        _deposit(alice, 10e18, 10e18);
        uint256 g = gasleft();
        _deposit(bob, 10e18, 10e18);
        uint256 request = g - gasleft();
        _settle();
        _postBond(1000e18);
        _winningEpoch();
        uint256 half = vault.balanceOf(alice) / 2;
        vm.prank(alice);
        vault.requestRedeem(half);
        _deposit(alice, 1e18, 1e18);
        vm.warp(vault.epochEndsAt());
        vm.roll(vm.getBlockNumber() + 1);
        g = gasleft();
        vault.settleEpoch();
        uint256 settle = g - gasleft();
        assertGt(vault.balanceOf(curator), 0, "the measured settlement charged a fee");
        vm.prank(curator);
        g = gasleft();
        vault.rebalance(-500, 500);
        uint256 rebalance = g - gasleft();
        emit log_named_uint("gas: requestDeposit", request);
        emit log_named_uint("gas: settleEpoch (fee, 1 redemption, 1 deposit)", settle);
        emit log_named_uint("gas: rebalance", rebalance);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Fuzz
    // ------------------------------------------------------------------------------------------------------------

    /// @dev With no swaps, entering and leaving never pays out more than was put in, for either depositor.
    function testFuzz_roundTripNeverPaysMoreThanDeposited(uint96 a0, uint96 a1, uint96 b0, uint96 b1) public {
        a0 = uint96(bound(a0, 1e6, 1e27));
        a1 = uint96(bound(a1, 1e6, 1e27));
        b0 = uint96(bound(b0, 1, 1e27));
        b1 = uint96(bound(b1, 1, 1e27));
        uint256[4] memory start =
            [token0.balanceOf(alice), token1.balanceOf(alice), token0.balanceOf(bob), token1.balanceOf(bob)];

        _deposit(alice, a0, a1);
        _deposit(bob, b0, b1);
        _settle();
        _assertSolvent();
        _exitAll(alice);
        _exitAll(bob);
        _settle();
        _assertSolvent();
        _claimAll(alice, 1);
        _claimAll(bob, 1);

        assertLe(token0.balanceOf(alice), start[0], "alice token0");
        assertLe(token1.balanceOf(alice), start[1], "alice token1");
        assertLe(token0.balanceOf(bob), start[2], "bob token0");
        assertLe(token1.balanceOf(bob), start[3], "bob token1");
        // and the vault keeps no more than rounding dust per depositor
        assertApproxEqAbs(token0.balanceOf(alice), start[0], 1e6);
        assertApproxEqAbs(token1.balanceOf(alice), start[1], 1e6);
    }

    /// @dev Whatever mix of deposits, swaps and redemptions, the vault always holds what it owes users.
    function testFuzz_alwaysSolvent(uint96 a, uint96 b, uint96 swapIn, bool dir, uint8 redeemPct) public {
        a = uint96(bound(a, 1e15, 1e24));
        b = uint96(bound(b, 1e15, 1e24));
        b = uint96(bound(b, uint256(a) / 5000 + 1, 1e24)); // above the minimum deposit
        swapIn = uint96(bound(swapIn, 1, a / 4 + 1));
        redeemPct = uint8(bound(redeemPct, 1, 100));

        _deposit(alice, a, a);
        _settle();
        _deposit(bob, b, uint256(b) * 3);
        vm.roll(vm.getBlockNumber() + 1);
        _swap(dir, swapIn);
        _assertSolvent();
        uint256 redeem = vault.balanceOf(alice) * redeemPct / 100;
        vm.prank(alice);
        vault.requestRedeem(redeem);
        _settle();
        _assertSolvent();
        _claimAll(alice, 1);
        _exitAll(bob);
        _settle();
        _claimAll(bob, 2);
        _assertSolvent();
    }

    function _exitAll(address user) internal {
        uint256 shares = vault.balanceOf(user);
        if (shares == 0) return;
        vm.prank(user);
        vault.requestRedeem(shares);
    }

    function _claimAll(address user, uint256 e) internal {
        vm.startPrank(user);
        if (vault.pendingRedeem(e, user) != 0) vault.claimRedemption(e);
        (uint256 r0, uint256 r1) = vault.refunds(user);
        if (r0 + r1 != 0) vault.claimRefund();
        vm.stopPrank();
    }
}
