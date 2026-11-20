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
        vault = new UkiyoVault(hook, 0, curator, EPOCH, "Ukiyo curator vault", "uCV");
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

    function _liquidity() internal view returns (uint128) {
        return hook.sleeve(0).liquidity;
    }

    /// @dev The vault never owes more than it holds.
    function _assertSolvent() internal view {
        (uint256 r0, uint256 r1) = vault.reserved();
        assertGe(token0.balanceOf(address(vault)), r0, "token0 below reserved");
        assertGe(token1.balanceOf(address(vault)), r1, "token1 below reserved");
    }

    // ------------------------------------------------------------------------------------------------------------
    // Hand-over and access control
    // ------------------------------------------------------------------------------------------------------------

    function test_managerIsSetOnceAndLocksOutTheOwner() public {
        assertEq(hook.sleeveManager(0), address(vault));
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
        new UkiyoVault(hook, 0, address(0), EPOCH, "x", "x");
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
