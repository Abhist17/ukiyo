// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

import {EdgeMath} from "../src/libraries/EdgeMath.sol";

/// @notice Checks EdgeMath's closed forms against Uniswap's own amount math.
contract EdgeMathTest is Test {
    int24 internal constant TICK_BOUND = 400_000;

    struct Case {
        uint128 l;
        uint160 lo;
        uint160 hi;
        uint160 s0;
        uint160 s1;
    }

    /// @dev Build a random in-range case: a range [tickLower, tickUpper] and two prices inside it.
    function _case(uint128 l, int24 tickA, int24 tickB, int24 tick0, int24 tick1)
        internal
        pure
        returns (Case memory c)
    {
        tickA = int24(bound(tickA, -TICK_BOUND, TICK_BOUND - 2));
        tickB = int24(bound(tickB, tickA + 2, TICK_BOUND));
        tick0 = int24(bound(tick0, tickA, tickB));
        tick1 = int24(bound(tick1, tickA, tickB));
        c.l = uint128(bound(l, 1e6, 1e27));
        c.lo = TickMath.getSqrtPriceAtTick(tickA);
        c.hi = TickMath.getSqrtPriceAtTick(tickB);
        c.s0 = TickMath.getSqrtPriceAtTick(tick0);
        c.s1 = TickMath.getSqrtPriceAtTick(tick1);
    }

    /// @dev Sleeve inventory at a price, from Uniswap's SqrtPriceMath (rounded down, as a withdrawal would be).
    function _inventory(Case memory c, uint160 s) internal pure returns (uint256 x, uint256 y) {
        uint160 p = EdgeMath.clip(s, c.lo, c.hi);
        x = p < c.hi ? SqrtPriceMath.getAmount0Delta(p, c.hi, c.l, false) : 0;
        y = p > c.lo ? SqrtPriceMath.getAmount1Delta(c.lo, p, c.l, false) : 0;
    }

    // ------------------------------------------------------------------------------------------------------------
    // clip
    // ------------------------------------------------------------------------------------------------------------

    function test_clip() public pure {
        assertEq(EdgeMath.clip(5, 10, 20), 10);
        assertEq(EdgeMath.clip(15, 10, 20), 15);
        assertEq(EdgeMath.clip(25, 10, 20), 20);
        assertEq(EdgeMath.clip(10, 10, 20), 10);
        assertEq(EdgeMath.clip(20, 10, 20), 20);
    }

    // ------------------------------------------------------------------------------------------------------------
    // The identity: V(s1) - V(s0) = x(s0)(P1 - P0) - loss, i.e. loss = x0*P1 + y0 - V(s1)
    // ------------------------------------------------------------------------------------------------------------

    /// @notice The closed-form loss equals the exact holding-vs-position gap computed from Uniswap's amount math.
    function testFuzz_rebalancingLoss_matchesInventoryIdentity(
        uint128 l,
        int24 tickA,
        int24 tickB,
        int24 tick0,
        int24 tick1
    ) public pure {
        Case memory c = _case(l, tickA, tickB, tick0, tick1);
        (uint256 x0, uint256 y0) = _inventory(c, c.s0);
        (uint256 x1, uint256 y1) = _inventory(c, c.s1);

        // Value both inventories at the second mark. Holding the first inventory is never worth less.
        uint256 hold = EdgeMath.token0ToToken1(x0, c.s1) + y0;
        uint256 pos = EdgeMath.token0ToToken1(x1, c.s1) + y1;
        uint256 loss = EdgeMath.rebalancingLoss(c.l, c.s0, c.s1, c.lo, c.hi);

        // Tolerance: each inventory amount is off by at most 1 wei, so the gap is off by at most
        // 2 token0 wei valued at P1 plus 2 token1 wei, plus rounding inside the closed form.
        uint256 tol = EdgeMath.token0ToToken1(2, c.s1) + 4 + loss / 1e12;
        uint256 gap = hold >= pos ? hold - pos : 0;
        assertApproxEqAbs(loss, gap, tol, "closed form != inventory gap");
    }

    function testFuzz_rebalancingLoss_zeroWithoutMove(uint128 l, int24 tickA, int24 tickB, int24 tick0) public pure {
        Case memory c = _case(l, tickA, tickB, tick0, tick0);
        assertEq(EdgeMath.rebalancingLoss(c.l, c.s0, c.s0, c.lo, c.hi), 0);
    }

    function testFuzz_rebalancingLoss_zeroOutsideRangeOnOneSide(uint128 l, int24 tickA, int24 tickB) public pure {
        Case memory c = _case(l, tickA, tickB, 0, 0);
        // Both marks above the range: the sleeve is all token1 and nothing moves.
        uint160 above1 = c.hi + 1;
        uint160 above2 = c.hi + 1000;
        assertEq(EdgeMath.rebalancingLoss(c.l, above1, above2, c.lo, c.hi), 0);
        // Both below.
        if (c.lo > 1001 + TickMath.MIN_SQRT_PRICE) {
            assertEq(EdgeMath.rebalancingLoss(c.l, c.lo - 1, c.lo - 1000, c.lo, c.hi), 0);
        }
    }

    /// @notice A move that leaves the range is charged only up to the range edge (continuous-rebalancing limit).
    function testFuzz_rebalancingLoss_clipsAtEdge(uint128 l, int24 tickA, int24 tickB, int24 tick0) public pure {
        Case memory c = _case(l, tickA, tickB, tick0, 0);
        uint160 far = c.hi + (c.hi >> 4);
        if (far > TickMath.MAX_SQRT_PRICE) far = uint160(TickMath.MAX_SQRT_PRICE);
        assertEq(
            EdgeMath.rebalancingLoss(c.l, c.s0, far, c.lo, c.hi), EdgeMath.rebalancingLoss(c.l, c.s0, c.hi, c.lo, c.hi)
        );
    }

    // ------------------------------------------------------------------------------------------------------------
    // Rounding policy: losses round up, credits round down
    // ------------------------------------------------------------------------------------------------------------

    function testFuzz_creditNeverExceedsLoss(uint128 l, int24 tickA, int24 tickB, int24 tick0, int24 tick1)
        public
        pure
    {
        Case memory c = _case(l, tickA, tickB, tick0, tick1);
        uint256 loss = EdgeMath.rebalancingLoss(c.l, c.s0, c.s1, c.lo, c.hi);
        uint256 credit = EdgeMath.impactCredit(c.l, c.s0, c.s1, c.lo, c.hi);
        assertLe(credit, loss);
        assertLe(loss - credit, 2, "rounding gap above 2 wei");
    }

    // ------------------------------------------------------------------------------------------------------------
    // Fee attribution
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Price up: the sleeve's net token1 input matches SqrtPriceMath and the fee is net * f / (1 - f).
    function testFuzz_swapFee_token1In(uint128 l, int24 tickA, int24 tickB, int24 tick0, int24 tick1, uint24 fee)
        public
        pure
    {
        Case memory c = _case(l, tickA, tickB, tick0, tick1);
        fee = uint24(bound(fee, 1, 100_000));
        (uint160 lo, uint160 hi) = c.s0 <= c.s1 ? (c.s0, c.s1) : (c.s1, c.s0);
        uint256 net1 = SqrtPriceMath.getAmount1Delta(lo, hi, c.l, false);
        uint256 expected = FullMath.mulDiv(net1, fee, 1e6 - fee);
        uint256 got = EdgeMath.swapFee(c.l, lo, hi, c.lo, c.hi, fee, hi);
        assertApproxEqAbs(got, expected, 1);
    }

    /// @notice Price down: the sleeve's net token0 input matches SqrtPriceMath; the fee is valued at the mark.
    function testFuzz_swapFee_token0In(uint128 l, int24 tickA, int24 tickB, int24 tick0, int24 tick1, uint24 fee)
        public
        pure
    {
        Case memory c = _case(l, tickA, tickB, tick0, tick1);
        fee = uint24(bound(fee, 1, 100_000));
        (uint160 lo, uint160 hi) = c.s0 <= c.s1 ? (c.s0, c.s1) : (c.s1, c.s0);
        uint256 net0 = SqrtPriceMath.getAmount0Delta(lo, hi, c.l, false);
        uint256 fee0 = FullMath.mulDiv(net0, fee, 1e6 - fee);
        uint256 expected = EdgeMath.token0ToToken1(fee0, lo);
        uint256 got = EdgeMath.swapFee(c.l, hi, lo, c.lo, c.hi, fee, lo);
        // net0 may differ by 1 wei of token0 from SqrtPriceMath's rounding; value that wei at the mark.
        assertApproxEqAbs(got, expected, EdgeMath.token0ToToken1(2, lo) + 1);
    }

    function test_swapFee_zeroFeeTier() public pure {
        uint160 a = TickMath.getSqrtPriceAtTick(-600);
        uint160 b = TickMath.getSqrtPriceAtTick(600);
        assertEq(EdgeMath.swapFee(1e18, a, b, a, b, 0, b), 0);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Worked example (documented in the README)
    // ------------------------------------------------------------------------------------------------------------

    /// @notice 1% price move on a full-ish range position: loss ≈ l * s * (Δs/s)^2.
    function test_workedExample_onePercentMove() public pure {
        uint128 l = 1e18;
        uint160 lo = TickMath.getSqrtPriceAtTick(-69_060); // about 0.001
        uint160 hi = TickMath.getSqrtPriceAtTick(69_060); // about 1000
        uint160 s0 = TickMath.getSqrtPriceAtTick(0); // price 1
        uint160 s1 = TickMath.getSqrtPriceAtTick(100); // price ~1.01005
        uint256 loss = EdgeMath.rebalancingLoss(l, s0, s1, lo, hi);
        // (sqrt(1.01005) - 1)^2 * 1e18 ≈ 2.5e13
        assertApproxEqRel(loss, 2.5e13, 0.01e18);
    }
}
