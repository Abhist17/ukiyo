// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {V4PoolManagerDeployer} from "hookmate/artifacts/V4PoolManager.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {UkiyoHook} from "../src/UkiyoHook.sol";
import {UkiyoVault} from "../src/UkiyoVault.sol";
import {UkiyoFactory} from "../src/UkiyoFactory.sol";
import {UkiyoSkillRouter} from "../src/UkiyoSkillRouter.sol";
import {UkiyoLens} from "../src/UkiyoLens.sol";

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
        vault =
            new UkiyoVault(hook, 0, curator, UkiyoVault.Terms(EPOCH, FEE_BPS, 0, 0, 0), "Ukiyo curator vault", "uCV");
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
        new UkiyoVault(hook, 0, address(0), UkiyoVault.Terms(EPOCH, 0, 0, 0, 0), "x", "x");
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
        new UkiyoVault(hook, 0, curator, UkiyoVault.Terms(EPOCH, 2001, 0, 0, 0), "x", "x");
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

    /// @notice Anyone may add to the bond (a backer, or the factory's launch bond), but only the curator manages it.
    function test_anyoneFundsTheBondOnlyCuratorManagesIt() public {
        token1.mint(stranger, 5e18);
        vm.startPrank(stranger);
        token1.approve(address(vault), 5e18);
        vault.postBond(5e18);
        assertEq(vault.bond(), 5e18, "a backer's bond counts");
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
    // Edge index
    // ------------------------------------------------------------------------------------------------------------

    /// @notice An epoch that starts with no capital has no return: the index stays at 1 and its clock does not run.
    function test_edgeIndexIgnoresEpochsWithoutCapital() public {
        _deposit(alice, 100e18, 100e18);
        _settle(); // the first epoch held only escrow
        assertEq(vault.edgeIndex(), 1e18);
        assertEq(vault.edgeIndexTime(), 0);
        assertEq(vault.epochStartValue(), vault.valueAtMark(), "next epoch's capital snapshotted");
        assertGt(vault.epochStartValue(), 0);
    }

    /// @notice Each epoch multiplies the index by 1 + Edge / starting capital, exactly, and losses pull it down.
    function test_edgeIndexCompoundsEachEpochsReturn() public {
        _deposit(alice, 100e18, 100e18);
        _settle();

        uint256 capital = vault.epochStartValue();
        _winningEpoch();
        int256 edgeUp = _epochEdge();
        assertGt(edgeUp, 0);
        _settle();
        uint256 expected = 1e18 * uint256(1e18 + edgeUp * 1e18 / int256(capital)) / 1e18;
        assertEq(vault.edgeIndex(), expected, "one epoch's return");
        assertGt(vault.edgeIndex(), 1e18);
        assertEq(vault.edgeIndexTime(), EPOCH);

        uint256 before = vault.edgeIndex();
        _losingEpoch();
        assertLt(_epochEdge(), 0);
        _settle();
        assertLt(vault.edgeIndex(), before, "a losing epoch lowers the index");
        assertEq(vault.edgeIndexTime(), 2 * EPOCH);
    }

    /// @notice Two curators with the same range and ten times different capital earn ten times different Edge but
    ///         the same index: the index ranks skill, not size.
    function test_edgeIndexIsSizeNeutral() public {
        hook.openSleeve(curator, -1000, 1000);
        UkiyoVault big = new UkiyoVault(hook, 1, curator, UkiyoVault.Terms(EPOCH, FEE_BPS, 0, 0, 0), "Big", "BIG");
        hook.setSleeveManager(1, address(big));
        vm.startPrank(alice);
        token0.approve(address(big), type(uint256).max);
        token1.approve(address(big), type(uint256).max);
        vault.requestDeposit(10e18, 10e18);
        big.requestDeposit(100e18, 100e18);
        vm.stopPrank();
        vm.warp(vault.epochEndsAt());
        vault.settleEpoch();
        big.settleEpoch();

        _winningEpoch();
        _losingEpoch();
        _winningEpoch();
        vm.warp(vault.epochEndsAt());
        vm.roll(vm.getBlockNumber() + 1);
        vault.settleEpoch();
        big.settleEpoch();

        assertApproxEqRel(hook.edge(1), 10 * hook.edge(0), 1e15, "raw Edge scales with size");
        assertApproxEqRel(big.edgeIndex(), vault.edgeIndex(), 1e12, "the index does not");
        assertTrue(vault.edgeIndex() != 1e18, "the epoch moved the index");
    }

    /// @dev Settle and return the epoch's recorded Edge return (1e18 = 100%).
    function _settleReturn() internal returns (int256) {
        int256 before = vault.edgeReturnSum();
        _settle();
        return vault.edgeReturnSum() - before;
    }

    /// @dev Reference t-statistic from the raw returns, the textbook way: mean / (sample sd / sqrt(n)), in 1e18.
    function _referenceT(int256[] memory r) internal pure returns (int256) {
        int256 n = int256(r.length);
        int256 sum;
        for (uint256 i; i < r.length; ++i) {
            sum += r[i];
        }
        int256 mean = sum / n;
        uint256 ss;
        for (uint256 i; i < r.length; ++i) {
            int256 d = r[i] - mean;
            ss += uint256(d * d);
        }
        uint256 sd = Math.sqrt(ss / uint256(n - 1)); // in 1e18 units, since r is
        return mean * int256(Math.sqrt(uint256(n) * 1e36)) / int256(sd);
    }

    /// @notice Under two recorded epochs there is no spread to test against: the statistic is zero.
    function test_skillNeedsTwoEpochs() public {
        _deposit(alice, 100e18, 100e18);
        _settle();
        _winningEpoch();
        _settle();
        assertEq(vault.edgeEpochs(), 1);
        assertEq(vault.edgeTStat(), 0);
        assertFalse(vault.hasSkill());
    }

    /// @notice A curator that earns Edge every epoch is reported as skilled, and the on-chain statistic agrees with the
    ///         textbook formula without ever exceeding it.
    function test_consistentEdgeIsSkill() public {
        _deposit(alice, 100e18, 100e18);
        _settle();
        int256[] memory r = new int256[](4);
        for (uint256 i; i < 4; ++i) {
            for (uint256 k; k <= i; ++k) {
                _winningEpoch(); // epochs of different size, so the returns have a spread
            }
            r[i] = _settleReturn();
            assertGt(r[i], 0);
        }
        int256 t = vault.edgeTStat();
        int256 ref = _referenceT(r);
        assertApproxEqRel(t, ref, 1e12, "matches the textbook t");
        assertLe(t, ref + 1, "never above it");
        assertTrue(vault.hasSkill());
    }

    /// @notice Winning and losing epochs in turn: a few good epochs do not make a skilled curator.
    function test_mixedRecordIsNotSkill() public {
        _deposit(alice, 100e18, 100e18);
        _settle();
        int256[] memory r = new int256[](4);
        for (uint256 i; i < 4; ++i) {
            if (i % 2 == 0) _winningEpoch();
            else _losingEpoch();
            r[i] = _settleReturn();
        }
        assertLt(vault.edgeTStat(), vault.SKILL_T());
        assertFalse(vault.hasSkill());
        assertApproxEqRel(vault.edgeTStat(), _referenceT(r), 1e12);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Probation and the minimum bond
    // ------------------------------------------------------------------------------------------------------------

    /// @dev A second vault on a new sleeve with the given terms, alice approved for it.
    function _vaultWith(uint256 probationBps, uint256 minBond) internal returns (UkiyoVault v) {
        hook.openSleeve(curator, -1000, 1000);
        uint256 id = hook.sleeveCount() - 1;
        v = new UkiyoVault(hook, id, curator, UkiyoVault.Terms(EPOCH, FEE_BPS, probationBps, minBond, 0), "P", "P");
        hook.setSleeveManager(id, address(v));
        vm.startPrank(alice);
        token0.approve(address(v), type(uint256).max);
        token1.approve(address(v), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev End the epoch and settle `v`.
    function _settleVault(UkiyoVault v) internal {
        vm.warp(v.epochEndsAt());
        vm.roll(vm.getBlockNumber() + 1);
        v.settleEpoch();
    }

    /// @notice A curator whose Edge index falls past its probation drawdown cannot move the range for
    ///         `PROBATION_EPOCHS` epochs, then can again.
    function test_probationStopsALosingCurator() public {
        UkiyoVault v = _vaultWith(1, 0); // a 0.01% drawdown
        vm.prank(alice);
        v.requestDeposit(100e18, 100e18);
        _settleVault(v);
        assertFalse(v.onProbation());

        for (uint256 i; i < 3; ++i) {
            _losingEpoch(); // about -0.6 bp each
        }
        _settleVault(v);
        assertTrue(v.onProbation(), "on probation after the drawdown");
        uint256 until = v.probationUntil();
        assertEq(until, v.epoch() + v.PROBATION_EPOCHS());
        assertEq(v.edgeIndexPeak(), v.edgeIndex(), "peak resets to where probation began");
        vm.startPrank(curator);
        vm.expectRevert(abi.encodeWithSelector(UkiyoVault.OnProbation.selector, until));
        v.rebalance(-500, 500);
        vm.expectRevert(abi.encodeWithSelector(UkiyoVault.OnProbation.selector, until));
        v.rebalanceWithSwap(-500, 500, true, 1);
        vm.stopPrank();

        for (uint256 i; i < v.PROBATION_EPOCHS(); ++i) {
            _settleVault(v); // quiet epochs: no further drawdown
        }
        assertFalse(v.onProbation(), "probation is served");
        vm.prank(curator);
        v.rebalance(-500, 500);
    }

    /// @notice With probation off, the same losing epoch leaves the curator free.
    function test_noProbationWhenOff() public {
        _deposit(alice, 100e18, 100e18);
        _settle();
        _losingEpoch();
        _settle();
        assertLt(vault.edgeIndex(), 1e18);
        assertFalse(vault.onProbation());
    }

    /// @notice The curator can withdraw bond only down to `minBond`; the rest stays for the vault's life.
    function test_minBondCannotBeWithdrawn() public {
        UkiyoVault v = _vaultWith(0, 10e18);
        token1.mint(curator, 15e18);
        vm.startPrank(curator);
        token1.approve(address(v), 15e18);
        v.postBond(15e18);
        v.requestBondWithdrawal(15e18);
        vm.stopPrank();
        uint256 before = token1.balanceOf(curator);
        _settleVault(v);
        assertEq(token1.balanceOf(curator) - before, 5e18, "only the part above the minimum");
        assertEq(v.bond(), 10e18);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Open launches through the factory
    // ------------------------------------------------------------------------------------------------------------

    function _factory() internal returns (UkiyoFactory f) {
        f = new UkiyoFactory(hook, EPOCH, 1000e18, 2000, 0);
        hook.setLauncher(address(f));
        vm.startPrank(alice);
        token1.approve(address(f), type(uint256).max);
        vm.stopPrank();
    }

    function _terms() internal pure returns (UkiyoVault.Terms memory) {
        return UkiyoVault.Terms({
            epochLength: EPOCH, performanceFeeBps: 1000, probationBps: 500, minBond: 1000e18, depositCap: 0
        });
    }

    /// @notice Anyone can launch a vault in one call: sleeve opened and handed over, launch bond posted, and the vault
    ///         takes deposits and earns like any other.
    function test_anyoneCanLaunchAVault() public {
        UkiyoFactory f = _factory();
        vm.prank(alice);
        UkiyoVault v = f.launch(type(UkiyoVault).creationCode, -500, 500, _terms(), "Alice", "ALC");

        assertEq(hook.sleeveManager(1), address(v), "the new sleeve is the vault's");
        assertTrue(hook.isSleeveManager(address(v)), "its own swaps are arbitrage");
        assertEq(hook.sleeve(1).curator, alice);
        assertEq(v.curator(), alice);
        assertEq(v.bond(), 1000e18, "launch bond posted");
        assertEq(v.minBond(), 1000e18);
        assertEq(v.probationBps(), 500);
        assertTrue(f.isLaunched(address(v)));
        assertEq(f.vaultCount(), 1);

        vm.startPrank(alice);
        token0.approve(address(v), type(uint256).max);
        token1.approve(address(v), type(uint256).max);
        v.requestDeposit(10e18, 10e18);
        vm.stopPrank();
        _settleVault(v);
        assertGt(hook.sleeve(1).liquidity, 0, "deposits go to work");
    }

    /// @notice The factory deploys only genuine vault code.
    function test_launchRejectsOtherCode() public {
        UkiyoFactory f = _factory();
        bytes memory fake = abi.encodePacked(type(UkiyoVault).creationCode, hex"00");
        vm.prank(alice);
        vm.expectRevert(UkiyoFactory.NotUkiyoVaultCode.selector);
        f.launch(fake, -500, 500, _terms(), "X", "X");
    }

    /// @notice Every launched vault offers depositors the factory's minimum protections.
    function test_launchEnforcesDepositorProtections() public {
        UkiyoFactory f = _factory();
        bytes memory code = type(UkiyoVault).creationCode;
        UkiyoVault.Terms[4] memory bad = [_terms(), _terms(), _terms(), _terms()];
        bad[0].epochLength = EPOCH - 1; // epochs too short
        bad[1].minBond = 999e18; // bond too small
        bad[2].probationBps = 0; // no probation
        bad[3].probationBps = 2001; // probation too loose
        vm.startPrank(alice);
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(UkiyoFactory.BadTerms.selector);
            f.launch(code, -500, 500, bad[i], "X", "X");
        }
        vm.stopPrank();
    }

    /// @notice Only the owner or its launcher can launch sleeves, and only the owner picks the launcher.
    function test_onlyOwnerOrLauncherLaunchesSleeves() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(UkiyoHook.NotLauncher.selector, stranger));
        hook.launchSleeve(stranger, -500, 500, stranger);
        vm.expectRevert();
        hook.setLauncher(stranger);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Deposit cap
    // ------------------------------------------------------------------------------------------------------------

    /// @dev A vault on a new sleeve with deposit cap `cap`, alice and bob approved for it.
    function _cappedVault(uint256 cap) internal returns (UkiyoVault v) {
        hook.openSleeve(curator, -1000, 1000);
        uint256 id = hook.sleeveCount() - 1;
        v = new UkiyoVault(hook, id, curator, UkiyoVault.Terms(EPOCH, FEE_BPS, 0, 0, cap), "C", "C");
        hook.setSleeveManager(id, address(v));
        address[2] memory users = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(users[i]);
            token0.approve(address(v), type(uint256).max);
            token1.approve(address(v), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// @notice Requests are taken while the vault's capital plus this epoch's escrow stays within the cap, up to it
    ///         exactly; one past it reverts and leaves nothing escrowed. Capital counts once settled.
    function test_depositCapLimitsNewMoney() public {
        UkiyoVault v = _cappedVault(100e18); // at the 1:1 price, 100 token1 of capital
        vm.prank(alice);
        v.requestDeposit(40e18, 40e18);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(UkiyoVault.DepositCapReached.selector, 110e18, 100e18));
        v.requestDeposit(15e18, 15e18);
        vm.prank(bob);
        v.requestDeposit(10e18, 10e18); // exactly at the cap
        (uint256 p0, uint256 p1) = v.pendingDeposits();
        assertEq(p0 + p1, 100e18, "both requests count against the cap");

        _settleVault(v);
        (p0, p1) = v.pendingDeposits();
        assertEq(p0 + p1, 0, "settlement empties the queue");
        assertApproxEqRel(v.valueAtMark(), 100e18, 1e15, "the deposits are now capital");
        vm.prank(bob);
        vm.expectPartialRevert(UkiyoVault.DepositCapReached.selector);
        v.requestDeposit(1e18, 1e18);
    }

    /// @notice Room comes back when a request is cancelled or capital is redeemed.
    function test_cancelAndRedemptionMakeRoom() public {
        UkiyoVault v = _cappedVault(100e18);
        vm.prank(alice);
        v.requestDeposit(50e18, 50e18);
        vm.startPrank(bob);
        vm.expectPartialRevert(UkiyoVault.DepositCapReached.selector);
        v.requestDeposit(1e18, 1e18);
        vm.stopPrank();
        vm.prank(alice);
        v.cancelDeposit();
        vm.prank(bob);
        v.requestDeposit(50e18, 50e18); // the cancelled request's room
        _settleVault(v);

        vm.startPrank(bob);
        vm.expectPartialRevert(UkiyoVault.DepositCapReached.selector);
        v.requestDeposit(10e18, 10e18);
        v.requestRedeem(v.balanceOf(bob) / 2);
        vm.stopPrank();
        _settleVault(v);
        vm.prank(alice);
        v.requestDeposit(24e18, 24e18); // half the capital left (plus rounding dust), so about 50 more fits
    }

    /// @notice The cap values the vault at the hook's reference price, like `valueAtMark`: a swap that pushes spot
    ///         within the block (here making the vault's token0 cheap) cannot make room for a deposit.
    function test_depositCapIgnoresAPriceMovedThisBlock() public {
        UkiyoVault v = _cappedVault(100e18);
        vm.prank(alice);
        v.requestDeposit(49e18, 49e18);
        _settleVault(v);
        vm.roll(vm.getBlockNumber() + 1);
        _arb(true, 1e18); // the block's mark
        uint256 before = v.valueAtMark();
        _swap(true, 20e18); // a big push after it, in the same block
        assertLt(hook.sqrtPriceX96(), hook.referenceSqrtPrice(), "spot is below the reference price");
        assertEq(v.valueAtMark(), before, "the cap's measure did not move");
        vm.prank(bob);
        vm.expectPartialRevert(UkiyoVault.DepositCapReached.selector);
        v.requestDeposit(2e18, 2e18); // fits only if the vault were valued at the pushed spot price
    }

    /// @notice A vault at its cap refuses the router's slice, which goes straight back to the depositor.
    function test_routerSkipsAFullVault() public {
        (UkiyoSkillRouter r, UkiyoVault[] memory list) = _router(_cappedVault(5e18));
        uint256 b0 = token0.balanceOf(bob);
        vm.prank(bob);
        (uint256[] memory a0,) = r.deposit(list, 10e18, 10e18);
        assertEq(a0[0], 5e18, "the uncapped vault took its half");
        assertEq(a0[1], 0, "the capped vault refused its slice");
        assertEq(b0 - token0.balanceOf(bob), 5e18, "bob paid only for what was escrowed");
        assertEq(token0.balanceOf(address(r)) + token1.balanceOf(address(r)), 0, "the router keeps nothing");
    }

    /// @notice A factory with `maxDepositCap` set (a guarded pilot) only launches vaults with a cap of at most that.
    function test_factoryCanRequireADepositCap() public {
        UkiyoFactory f = new UkiyoFactory(hook, EPOCH, 1000e18, 2000, 500e18);
        hook.setLauncher(address(f));
        bytes memory code = type(UkiyoVault).creationCode;
        UkiyoVault.Terms memory t = _terms();
        vm.startPrank(alice);
        token1.approve(address(f), type(uint256).max);
        vm.expectRevert(UkiyoFactory.BadTerms.selector);
        f.launch(code, -500, 500, t, "X", "X"); // no cap
        t.depositCap = 500e18 + 1;
        vm.expectRevert(UkiyoFactory.BadTerms.selector);
        f.launch(code, -500, 500, t, "X", "X"); // above the factory's
        t.depositCap = 500e18;
        UkiyoVault v = f.launch(code, -500, 500, t, "X", "X");
        vm.stopPrank();
        assertEq(v.depositCap(), 500e18);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Skill router
    // ------------------------------------------------------------------------------------------------------------

    /// @dev A router over the main vault and `other`, bob approved for it.
    function _router(UkiyoVault other) internal returns (UkiyoSkillRouter r, UkiyoVault[] memory list) {
        address[] memory core = new address[](2);
        core[0] = address(vault);
        core[1] = address(other);
        r = new UkiyoSkillRouter(_factory(), core);
        list = new UkiyoVault[](2);
        list[0] = vault;
        list[1] = other;
        vm.startPrank(bob);
        token0.approve(address(r), type(uint256).max);
        token1.approve(address(r), type(uint256).max);
        vm.stopPrank();
    }

    /// @notice With no track record anywhere, a deposit splits evenly, and every share and refund is the depositor's.
    function test_routerSplitsEvenlyWithoutEvidence() public {
        (UkiyoSkillRouter r, UkiyoVault[] memory list) = _router(_vaultWith(0, 0));
        uint256[] memory w = r.weights(list);
        assertEq(w[0], 5000);
        assertEq(w[1], 5000);

        vm.prank(bob);
        r.deposit(list, 10e18, 10e18);
        for (uint256 i; i < 2; ++i) {
            (uint256 a0, uint256 a1) = list[i].pendingDeposit(0, bob);
            assertEq(a0, 5e18, "half of token0, in bob's name");
            assertEq(a1, 5e18);
        }
        assertEq(token0.balanceOf(address(r)) + token1.balanceOf(address(r)), 0, "the router keeps nothing");

        vm.warp(vault.epochEndsAt());
        vault.settleEpoch();
        list[1].settleEpoch();
        assertGt(vault.balanceOf(bob), 0, "bob holds the shares directly");
        assertGt(list[1].balanceOf(bob), 0);
    }

    /// @notice Once curators have records, weights follow their skill tests: positive t-statistics, capped, in
    ///         proportion; a curator whose t is not positive gets nothing.
    function test_routerFollowsTheSkillTest() public {
        UkiyoVault tight = _vaultWith(0, 0);
        (UkiyoSkillRouter r, UkiyoVault[] memory list) = _router(tight);
        vm.startPrank(alice);
        vault.requestDeposit(100e18, 100e18);
        tight.requestDeposit(100e18, 100e18);
        vm.stopPrank();
        vm.warp(vault.epochEndsAt());
        vault.settleEpoch();
        tight.settleEpoch();
        for (uint256 i; i < 4; ++i) {
            for (uint256 k; k <= i; ++k) {
                _winningEpoch();
            }
            if (i == 3) _losingEpoch();
            vm.warp(vault.epochEndsAt());
            vm.roll(vm.getBlockNumber() + 1);
            vault.settleEpoch();
            tight.settleEpoch();
        }

        uint256[] memory w = r.weights(list);
        uint256[2] memory score;
        for (uint256 i; i < 2; ++i) {
            int256 t = list[i].edgeTStat();
            score[i] = t <= 0 ? 0 : Math.min(uint256(t), r.MAX_T());
        }
        assertGt(score[0] + score[1], 0, "some curator has shown skill");
        assertEq(w[0] + w[1], 10_000);
        assertApproxEqAbs(w[0], score[0] * 10_000 / (score[0] + score[1]), 1, "in proportion to the skill test");
    }

    /// @notice A curator on probation gets none of a new deposit.
    function test_routerSkipsCuratorsOnProbation() public {
        UkiyoVault shaky = _vaultWith(1, 0);
        (UkiyoSkillRouter r, UkiyoVault[] memory list) = _router(shaky);
        vm.prank(alice);
        shaky.requestDeposit(100e18, 100e18);
        _settleVault(shaky);
        for (uint256 i; i < 3; ++i) {
            _losingEpoch();
        }
        _settleVault(shaky);
        assertTrue(shaky.onProbation());
        uint256[] memory w = r.weights(list);
        assertEq(w[1], 0, "nothing to the curator on probation");
        assertEq(w[0], 10_000);
    }

    /// @notice A slice a vault refuses (here, below its minimum deposit) goes straight back to the depositor.
    function test_routerReturnsRefusedSlices() public {
        _deposit(alice, 100e18, 100e18);
        _settle(); // the main vault now holds capital, so a dust slice is below its minimum
        (UkiyoSkillRouter r, UkiyoVault[] memory list) = _router(_vaultWith(0, 0));
        uint256 b0 = token0.balanceOf(bob);
        vm.prank(bob);
        (uint256[] memory a0,) = r.deposit(list, 1e12, 1e12);
        assertEq(a0[0], 0, "the main vault refused its dust slice");
        assertGt(a0[1], 0, "the empty vault took its slice");
        assertEq(b0 - token0.balanceOf(bob), a0[1], "bob paid only for what was escrowed");
        assertEq(token0.balanceOf(address(r)), 0);
    }

    /// @notice Only the deployment's own and factory-launched vaults, each listed once.
    function test_routerRejectsBadLists() public {
        (UkiyoSkillRouter r, UkiyoVault[] memory list) = _router(_vaultWith(0, 0));
        hook.openSleeve(curator, -1000, 1000);
        UkiyoVault stray = new UkiyoVault(hook, 3, curator, UkiyoVault.Terms(EPOCH, 0, 0, 0, 0), "S", "S");
        UkiyoVault[] memory bad = new UkiyoVault[](1);
        bad[0] = stray;
        vm.expectRevert(abi.encodeWithSelector(UkiyoSkillRouter.NotEligible.selector, address(stray)));
        r.weights(bad);
        list[1] = list[0];
        vm.expectRevert(UkiyoSkillRouter.BadVaultList.selector);
        r.weights(list);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Manipulation and griefing (from the review)
    // ------------------------------------------------------------------------------------------------------------

    /// @notice The attack: push the price, settle so the batch's capital is added at it, push back. Settling and
    ///         rebalancing refuse a spot price this transaction could have moved, and work again once it is back.
    function test_settleAndRebalanceRefuseAManipulatedPrice() public {
        _backgroundLiquidity(1e21);
        _deposit(alice, 100e18, 100e18);
        _settle();
        _deposit(bob, 100e18, 100e18); // the batch an attacker would want added at a bad price

        vm.warp(vault.epochEndsAt());
        vm.roll(vm.getBlockNumber() + 1);
        uint160 fair = hook.sqrtPriceX96();
        _arb(false, 30e18); // the attacker's push leads the block, so it is this block's own mark
        assertGt(hook.sqrtPriceX96(), fair);
        assertEq(hook.referenceSqrtPrice(), fair, "the reference is the mark before this block");
        bytes memory offMark = abi.encodeWithSelector(UkiyoVault.PriceOffMark.selector, hook.sqrtPriceX96(), fair);
        vm.expectRevert(offMark);
        vault.settleEpoch();
        vm.prank(curator);
        vm.expectRevert(offMark);
        vault.rebalance(-500, 500);

        // pushed back within the block. The next block's reference is still the pushed mark, so settling waits one
        // more block, after which the fair price is both spot and reference.
        _arb(true, 30e18 + 1e17);
        vm.roll(vm.getBlockNumber() + 1);
        _arb(true, 1);
        vm.roll(vm.getBlockNumber() + 1);
        vault.settleEpoch();
        assertGt(vault.balanceOf(bob), 0);
    }

    /// @notice Cancelling frees the slot, so request-and-cancel loops cannot fill the epoch's queue for nothing.
    function test_cancelFreesTheDepositSlot() public {
        uint256 max = vault.MAX_DEPOSITORS_PER_EPOCH();
        for (uint256 i; i < max; ++i) {
            address u = address(uint160(0x1000 + i));
            token0.mint(u, 1e18);
            vm.startPrank(u);
            token0.approve(address(vault), 1e18);
            vault.requestDeposit(1e18, 0);
            vm.stopPrank();
        }
        vm.prank(bob);
        vm.expectRevert(UkiyoVault.EpochFull.selector);
        vault.requestDeposit(1e18, 1e18);

        vm.prank(address(uint160(0x1000)));
        vault.cancelDeposit();
        assertEq(vault.depositorCount(0), max - 1, "the slot is free again");
        vm.prank(bob);
        vault.requestDeposit(1e18, 1e18);
        assertEq(vault.depositorCount(0), max);
    }

    /// @notice The minimum deposit must be met in a token the vault holds: dust of a token it has none of is refused.
    function test_minimumIsMetInAHeldToken() public {
        hook.openSleeve(curator, 1000, 2000); // entirely above the price: the position holds token0 only
        UkiyoVault v = new UkiyoVault(hook, 1, curator, UkiyoVault.Terms(EPOCH, 0, 0, 0, 0), "A", "A");
        hook.setSleeveManager(1, address(v));
        vm.startPrank(alice);
        token0.approve(address(v), type(uint256).max);
        token1.approve(address(v), type(uint256).max);
        v.requestDeposit(100e18, 0);
        vm.stopPrank();
        _settleVault(v);
        (uint256 h0, uint256 h1) = v.holdings();
        assertGt(h0, 0);
        assertEq(h1, 0);
        vm.startPrank(bob);
        token1.approve(address(v), type(uint256).max);
        vm.expectRevert(UkiyoVault.DepositTooSmall.selector);
        v.requestDeposit(0, 1);
        vm.stopPrank();
    }

    /// @notice Tokens sent to the vault mid-epoch stay idle through a rebalance, so they cannot earn Edge that the
    ///         epoch's return would then divide by the smaller starting capital.
    function test_midEpochRebalanceDeploysNoMoreThanTheEpochsCapital() public {
        _deposit(alice, 100e18, 100e18);
        _settle();
        uint256 capital = vault.epochStartValue();
        token1.mint(address(vault), 10_000e18); // a "donation" a curator could make to inflate its Edge return
        vm.prank(curator);
        vault.rebalance(-1000, 1000);
        (uint256 p0, uint256 p1) = hook.sleeveAmounts(0);
        uint160 m = hook.referenceSqrtPrice();
        uint256 deployed = p1 + EdgeMathLike.toToken1(p0, m);
        assertLe(deployed, capital + capital / 1e9 + 2, "deployed value stays within the epoch's capital");
        (, uint256 i1) = _idleOf(vault);
        assertGe(i1, 9000e18, "the donation waits, idle, for the next settlement");
    }

    /// @dev The vault's idle tokens (balance minus reserved and bond).
    function _idleOf(UkiyoVault v) internal view returns (uint256 i0, uint256 i1) {
        (uint256 r0, uint256 r1) = v.reserved();
        i0 = token0.balanceOf(address(v)) - r0;
        i1 = token1.balanceOf(address(v)) - r1 - v.bond();
    }

    /// @notice A vault's epoch must be shorter than the delay on raising the arbitrage threshold, so depositors can
    ///         always leave before a raise applies.
    function test_epochMustBeShorterThanTheThresholdDelay() public {
        uint256 delay = hook.THRESHOLD_RAISE_DELAY();
        hook.openSleeve(curator, -1000, 1000);
        vm.expectRevert(abi.encodeWithSelector(UkiyoVault.EpochTooLong.selector, delay, delay));
        new UkiyoVault(hook, 1, curator, UkiyoVault.Terms(delay, 0, 0, 0, 0), "L", "L");
    }

    // ------------------------------------------------------------------------------------------------------------
    // Lens
    // ------------------------------------------------------------------------------------------------------------

    /// @notice One call returns every sleeve's line, matching the hook and the vault read one by one; a sleeve run by
    ///         the owner rather than a vault is reported without vault fields.
    function test_lensMatchesDirectReads() public {
        _backgroundLiquidity(1e21); // sleeve 1: owner-run, no vault
        _deposit(alice, 100e18, 100e18);
        _settle();
        _winningEpoch();
        _settle();
        _winningEpoch();
        _losingEpoch();
        _settle();

        UkiyoLens lens = new UkiyoLens();
        (UkiyoLens.Pool memory pool, UkiyoLens.Row[] memory rows) = lens.scoreboard(hook);
        assertEq(pool.sleeveCount, 2);
        assertEq(pool.sqrtPriceX96, hook.sqrtPriceX96());
        assertEq(pool.referenceSqrtPriceX96, hook.referenceSqrtPrice());
        assertEq(pool.priorityFeeThreshold, hook.priorityFeeThreshold());

        UkiyoLens.Row memory r = rows[0];
        assertTrue(r.isVault);
        assertEq(r.manager, address(vault));
        assertEq(r.curator, curator);
        assertEq(r.edge, hook.edge(0));
        assertEq(r.ledger.arbLoss, hook.ledger(0).arbLoss);
        assertEq(r.liquidity, hook.sleeve(0).liquidity);
        assertEq(r.edgeIndex, vault.edgeIndex());
        assertEq(r.edgeTStat, vault.edgeTStat());
        assertEq(r.edgeEpochs, vault.edgeEpochs());
        assertEq(r.hasSkill, vault.hasSkill());
        assertEq(r.capital, vault.valueAtMark());
        assertEq(r.bond, vault.bond());
        assertEq(r.epoch, vault.epoch());
        (uint256 h0, uint256 h1) = vault.holdings();
        assertEq(r.amount0, h0);
        assertEq(r.amount1, h1);
        assertEq(r.symbol, vault.symbol());
        assertEq(r.epochStartEdge, vault.epochStartEdge());
        assertEq(r.curatorShares, vault.balanceOf(curator));

        assertFalse(rows[1].isVault, "an owner-run sleeve has no vault");
        assertEq(rows[1].manager, address(0));
        assertEq(rows[1].edge, hook.edge(1));
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

/// @dev token0 valued in token1 at a square-root price, as the vault does.
library EdgeMathLike {
    function toToken1(uint256 a0, uint160 p) internal pure returns (uint256) {
        return Math.mulDiv(Math.mulDiv(a0, p, 1 << 96), p, 1 << 96);
    }
}
