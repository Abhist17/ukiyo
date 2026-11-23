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

import {UkiyoHook} from "../../src/UkiyoHook.sol";
import {UkiyoVault} from "../../src/UkiyoVault.sol";

/// @notice Drives the vault with random sequences of everything its users, its curator, traders and settlers can do.
///         Calls that revert are simply skipped (the invariants must hold whatever lands).
contract VaultHandler is Test {
    UkiyoHook internal hook;
    UkiyoVault internal vault;
    PoolSwapTest internal router;
    PoolKey internal key;
    MockERC20 internal token0;
    MockERC20 internal token1;
    address internal curator;
    address[4] internal actors;

    uint256 internal constant BASE_FEE = 1 gwei;
    uint256 internal constant THRESHOLD = 1 gwei;

    /// @notice How often each action ran, for the run summary.
    mapping(bytes32 action => uint256) public calls;

    /// @notice How often each action succeeded: proof the invariants were checked against real state changes.
    mapping(bytes32 action => uint256) public ok;

    constructor(UkiyoHook hook_, UkiyoVault vault_, PoolSwapTest router_, PoolKey memory key_, address curator_) {
        hook = hook_;
        vault = vault_;
        router = router_;
        key = key_;
        token0 = MockERC20(Currency.unwrap(key_.currency0));
        token1 = MockERC20(Currency.unwrap(key_.currency1));
        curator = curator_;
        for (uint256 i; i < 4; ++i) {
            actors[i] = address(uint160(0xA11CE + i));
            _fund(actors[i]);
        }
        _fund(curator);
        token0.mint(address(this), 1e30);
        token1.mint(address(this), 1e30);
        token0.approve(address(router_), type(uint256).max);
        token1.approve(address(router_), type(uint256).max);
    }

    function _fund(address a) internal {
        token0.mint(a, 1e30);
        token1.mint(a, 1e30);
        vm.startPrank(a);
        token0.approve(address(vault), type(uint256).max);
        token1.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    // ----------------------------------------------------------------------------------------------------------------
    // Depositors
    // ----------------------------------------------------------------------------------------------------------------

    function deposit(uint256 seed, uint96 a0, uint96 a1) external {
        calls["deposit"]++;
        vm.prank(_actor(seed));
        try vault.requestDeposit(bound(a0, 1, 1e24), bound(a1, 1, 1e24)) {
            ok["deposit"]++;
        } catch {}
    }

    function cancel(uint256 seed) external {
        calls["cancel"]++;
        vm.prank(_actor(seed));
        try vault.cancelDeposit() {} catch {}
    }

    function redeem(uint256 seed, uint256 pct) external {
        calls["redeem"]++;
        address a = _actor(seed);
        uint256 shares = vault.balanceOf(a) * bound(pct, 1, 100) / 100;
        vm.prank(a);
        try vault.requestRedeem(shares) {
            ok["redeem"]++;
        } catch {}
    }

    function claim(uint256 seed, uint256 back) external {
        calls["claim"]++;
        address a = _actor(seed);
        uint256 e = vault.epoch();
        // payouts wait in recent epochs, so aim there
        uint256 target = e == 0 ? 0 : e - 1 - bound(back, 0, e - 1 < 2 ? e - 1 : 2);
        vm.startPrank(a);
        try vault.claimRedemption(target) {
            ok["claim"]++;
        } catch {}
        try vault.claimRefund() {} catch {}
        vm.stopPrank();
    }

    // ----------------------------------------------------------------------------------------------------------------
    // Traders and settlement
    // ----------------------------------------------------------------------------------------------------------------

    /// @notice Trade toward a random target price inside the sleeves' band, as a user or as an arbitrageur. Aiming at
    ///         a price rather than an edge keeps the pool moving both ways instead of pinning it at a limit.
    function swap(int24 targetTick, uint96 amount, bool asArb, bool newBlock) external {
        calls["swap"]++;
        if (newBlock) vm.roll(vm.getBlockNumber() + 1);
        vm.txGasPrice(BASE_FEE + (asArb ? THRESHOLD : 0));
        uint160 target = TickMath.getSqrtPriceAtTick(int24(bound(targetTick, -3000, 3000)));
        uint160 now_ = hook.sqrtPriceX96();
        if (target == now_) return;
        bool zeroForOne = target < now_;
        try router.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne, amountSpecified: -int256(bound(amount, 1, 5e19)), sqrtPriceLimitX96: target
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {
            ok["swap"]++;
        } catch {}
    }

    function settle() external {
        calls["settle"]++;
        vm.warp(vault.epochEndsAt());
        vm.roll(vm.getBlockNumber() + 1);
        try vault.settleEpoch() {
            ok["settle"]++;
        } catch {}
    }

    // ----------------------------------------------------------------------------------------------------------------
    // Curator
    // ----------------------------------------------------------------------------------------------------------------

    function rebalance(int24 centre, uint24 halfWidth, bool withSwap, bool zeroForOne, uint96 amountIn) external {
        calls["rebalance"]++;
        int24 c = int24(bound(centre, -3000, 3000)) / 10 * 10;
        int24 w = int24(uint24(bound(halfWidth, 1, 200))) * 10;
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(curator);
        if (withSwap) {
            try vault.rebalanceWithSwap(c - w, c + w, zeroForOne, bound(amountIn, 1, 1e22)) {
                ok["rebalanceWithSwap"]++;
            } catch {}
        } else {
            try vault.rebalance(c - w, c + w) {
                ok["rebalance"]++;
            } catch {}
        }
    }

    function bond(uint96 amount, bool withdraw, uint16 budget) external {
        calls["bond"]++;
        vm.startPrank(curator);
        if (withdraw) {
            vault.requestBondWithdrawal(bound(amount, 0, 1e22));
        } else {
            try vault.postBond(bound(amount, 1, 1e22)) {} catch {}
        }
        vault.setLvrBudget(bound(budget, 0, 1000));
        vm.stopPrank();
    }

    /// @notice Every holder of shares the handler can create, for the supply check.
    function holders() external view returns (address[] memory h) {
        h = new address[](7);
        for (uint256 i; i < 4; ++i) {
            h[i] = actors[i];
        }
        h[4] = curator;
        h[5] = address(vault);
        h[6] = 0x000000000000000000000000000000000000dEaD;
    }
}

/// @notice Stateful invariants of the curator vault under random sequences of every action, with real swaps through the
///         hook on the canonical PoolManager.
contract UkiyoVaultInvariantTest is Test {
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
    );

    UkiyoHook internal hook;
    UkiyoVault internal vault;
    VaultHandler internal handler;
    MockERC20 internal token0;
    MockERC20 internal token1;
    uint256 internal lastEpoch;

    function setUp() public {
        IPoolManager manager = IPoolManager(V4PoolManagerDeployer.deploy(address(this)));
        PoolSwapTest router = new PoolSwapTest(manager);
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);

        address target = address(HOOK_FLAGS | (uint160(0x4444) << 144));
        deployCodeTo("UkiyoHook.sol:UkiyoHook", abi.encode(manager, address(this), uint256(1 gwei)), target);
        hook = UkiyoHook(target);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            fee: 500,
            tickSpacing: 10,
            hooks: IHooks(target)
        });
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));

        // a second, owner-run sleeve gives the vault's own swaps liquidity to trade against
        hook.openSleeve(address(this), -6000, 6000);
        token0.mint(address(this), 1e30);
        token1.mint(address(this), 1e30);
        token0.approve(address(hook), type(uint256).max);
        token1.approve(address(hook), type(uint256).max);

        address curator = makeAddr("curator");
        hook.openSleeve(curator, -1000, 1000);
        vault = new UkiyoVault(hook, 1, curator, UkiyoVault.Terms(1 days, 1000, 10, 0), "v", "v"); // probation at 0.1%
        hook.setSleeveManager(1, address(vault));
        hook.modifySleeveLiquidity(0, 1e21);
        vm.fee(1 gwei);

        handler = new VaultHandler(hook, vault, router, key, curator);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = VaultHandler.deposit.selector;
        selectors[1] = VaultHandler.cancel.selector;
        selectors[2] = VaultHandler.redeem.selector;
        selectors[3] = VaultHandler.claim.selector;
        selectors[4] = VaultHandler.swap.selector;
        selectors[5] = VaultHandler.settle.selector;
        selectors[6] = VaultHandler.rebalance.selector;
        selectors[7] = VaultHandler.bond.selector;
        selectors[8] = VaultHandler.settle.selector; // settle twice as often: epochs must turn over
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice The vault always holds every token it owes: escrows, refunds, payouts and the curator's bond.
    function invariant_solvent() public view {
        (uint256 r0, uint256 r1) = vault.reserved();
        assertGe(token0.balanceOf(address(vault)), r0, "token0 below what is owed");
        assertGe(token1.balanceOf(address(vault)), r1 + vault.bond(), "token1 below what is owed plus bond");
    }

    /// @notice Shares are only ever held by the people who can get them: nothing is minted out of thin air.
    function invariant_supplyAddsUp() public view {
        address[] memory h = handler.holders();
        uint256 sum;
        for (uint256 i; i < h.length; ++i) {
            sum += vault.balanceOf(h[i]);
        }
        assertEq(sum, vault.totalSupply(), "shares outside the known holders");
    }

    /// @notice Shares handed in for redemption stay escrowed in the vault until their epoch settles.
    function invariant_redemptionsEscrowed() public view {
        assertGe(vault.balanceOf(address(vault)), vault.totalRedeem(vault.epoch()), "escrowed shares missing");
    }

    /// @notice Edge per share can sit below the high-water mark (losses to earn back) but the mark itself never goes
    ///         negative: it starts at zero and is only ever raised to a new high.
    function invariant_highWaterMarkNeverNegative() public view {
        assertGe(vault.highWaterMark(), 0, "the high-water mark fell below its start");
    }

    /// @notice A probation never outlasts `PROBATION_EPOCHS`, and the Edge index never sits above its tracked peak.
    function invariant_probationBounded() public view {
        assertLe(vault.probationUntil(), vault.epoch() + vault.PROBATION_EPOCHS(), "probation too long");
        assertLe(vault.edgeIndex(), vault.edgeIndexPeak(), "index above its peak");
    }

    /// @notice Guards against a handler whose calls all revert: once a run has tried an action a few times, some of
    ///         those calls must have landed. (A run can, by chance, pick an action rarely or never; that is no failure.)
    function afterInvariant() public view {
        if (handler.calls("settle") >= 5) assertGt(handler.ok("settle"), 0, "no epoch ever settled");
        if (handler.calls("swap") >= 5) assertGt(handler.ok("swap"), 0, "no swap ever landed");
    }
}
