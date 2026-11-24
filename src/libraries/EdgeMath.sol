// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {ProtocolFeeLibrary} from "v4-core/src/libraries/ProtocolFeeLibrary.sol";

/// @title EdgeMath
/// @author Abhist Kamle
/// @notice Closed-form accounting for one concentrated-liquidity position ("sleeve") between two price marks.
///
/// @dev Notation. `s` is the pool's square-root price as a Q64.96 number (`sqrtPriceX96`), so the real
///      square-root price is `s / 2^96` and the price of token0 in token1 is `P = (s / 2^96)^2`.
///      A sleeve with liquidity `l` over the range `[a, b]` (square-root prices) holds
///
///          x(s) = l * (1/c - 1/b)    token0
///          y(s) = l * (c - a)        token1          where c = clip(s, a, b)
///
///      All money amounts returned here are in raw token1 units.
///
///      The key identity (Ukiyo design doc, "The math"): when the price moves from s0 to s1 inside the range,
///
///          V(s1) - V(s0) = x(s0) * (P1 - P0)  -  l * (c1 - c0)^2 / c0
///
///      where V(s) = x(s) * P + y(s) is the sleeve's value marked at the pool price. The first term is pure market
///      exposure (what a holder of the same inventory would gain or lose); the second is the rebalancing loss, the
///      closed form Ukiyo accumulates. The range constants `a` and `b` cancel, which is why the same formula works for
///      any range.
///
///      Rounding policy. Every term that LOWERS a curator's Edge (losses) rounds UP, and every term that RAISES it
///      (fee and impact credits) rounds DOWN. Rounding can therefore only understate Edge, never overstate it.
library EdgeMath {
    /// @dev 2^96, the fixed-point base of `sqrtPriceX96`.
    uint256 internal constant Q96 = 0x1000000000000000000000000;

    /// @dev Uniswap v4 fee unit: fees are expressed in hundredths of a basis point (1e6 = 100%).
    uint256 internal constant PIPS = 1_000_000;

    /// @notice Clamp a square-root price into a sleeve's range.
    /// @dev Outside the range a sleeve holds a single token and its value no longer bends with price, so every
    ///      formula below is evaluated on the clipped price.
    /// @param s The square-root price to clamp (Q64.96).
    /// @param lower The sleeve's lower square-root price bound (Q64.96).
    /// @param upper The sleeve's upper square-root price bound (Q64.96).
    /// @return c `s` clamped to `[lower, upper]`.
    function clip(uint160 s, uint160 lower, uint160 upper) internal pure returns (uint160 c) {
        if (s < lower) return lower;
        if (s > upper) return upper;
        return s;
    }

    /// @notice Rebalancing loss of a sleeve when the price moves between two marks: `l * (c1 - c0)^2 / c0`.
    /// @dev This is the exact gap, at the second mark, between holding the sleeve and holding the inventory it had at
    ///      the first mark. Ukiyo uses it for the arbitrage-loss term, marked right after each block's first swap.
    ///      Rounds UP. Returns 0 when both clipped marks coincide (no move, or both outside the range on one side).
    /// @param l Sleeve liquidity.
    /// @param s0 Square-root price at the earlier mark (Q64.96).
    /// @param s1 Square-root price at the later mark (Q64.96).
    /// @param lower Lower square-root price bound of the sleeve (Q64.96).
    /// @param upper Upper square-root price bound of the sleeve (Q64.96).
    /// @return loss The loss in raw token1 units, rounded up.
    function rebalancingLoss(uint128 l, uint160 s0, uint160 s1, uint160 lower, uint160 upper)
        internal
        pure
        returns (uint256 loss)
    {
        (uint256 c0, uint256 d) = _clippedMove(s0, s1, lower, upper);
        if (d == 0) return 0;
        // l * d^2 / (c0 * 2^96), split into two 512-bit-safe mulDivs.
        loss = FullMath.mulDivRoundingUp(l, FullMath.mulDivRoundingUp(d, d, c0), Q96);
    }

    /// @notice Price-impact credit for user flow: the same closed form as `rebalancingLoss`, rounded DOWN.
    /// @dev Ukiyo credits the net displacement users leave between the post-arbitrage mark and the block close,
    ///      because the next block's arbitrage reverts it in the LPs' favour. Using the net move per block (not the sum
    ///      of per-swap moves) makes a same-block buy-and-sell earn zero credit.
    /// @param l Sleeve liquidity.
    /// @param sPost Square-root price right after the block's first swap (Q64.96).
    /// @param sClose Square-root price at the block's close (Q64.96).
    /// @param lower Lower square-root price bound of the sleeve (Q64.96).
    /// @param upper Upper square-root price bound of the sleeve (Q64.96).
    /// @return credit The credit in raw token1 units, rounded down.
    function impactCredit(uint128 l, uint160 sPost, uint160 sClose, uint160 lower, uint160 upper)
        internal
        pure
        returns (uint256 credit)
    {
        (uint256 c0, uint256 d) = _clippedMove(sPost, sClose, lower, upper);
        if (d == 0) return 0;
        credit = FullMath.mulDiv(l, FullMath.mulDiv(d, d, c0), Q96);
    }

    /// @notice The LPs' fee per unit of a swap's net input, as `numerator / denominator`.
    /// @dev Mirrors Uniswap v4's `Pool.swap`. The total fee is `swapFee` of the gross input, where
    ///      `swapFee = protocolFee + lpFee - protocolFee * lpFee / 1e6` (`ProtocolFeeLibrary.calculateSwapFee`), and the
    ///      protocol keeps `protocolFee` of the gross input; the net input is the gross minus the total fee. So
    ///      `lp fee = net * (swapFee - protocolFee) / (1e6 - swapFee)`. With no protocol fee this is `f / (1 - f)`.
    /// @param lpFee The pool's LP fee in hundredths of a basis point.
    /// @param protocolFee The protocol fee for the swap's direction, in hundredths of a basis point (at most 1000).
    /// @return numerator The LPs' part of the fee rate, in pips.
    /// @return denominator The net input's part of the gross input, in pips.
    function lpFeeRate(uint24 lpFee, uint16 protocolFee)
        internal
        pure
        returns (uint256 numerator, uint256 denominator)
    {
        uint256 total = protocolFee == 0 ? lpFee : ProtocolFeeLibrary.calculateSwapFee(protocolFee, lpFee);
        if (total >= PIPS) return (0, 1); // a 100% fee leaves no net input to earn on
        return (total - protocolFee, PIPS - total);
    }

    /// @notice LP fee a sleeve earns from one swap that moves the price from `s0` to `s1`, valued in token1.
    /// @dev The sleeve's share of the swap's input is exact from the price path:
    ///        price up   (token1 in): net1 = l * (c1 - c0)
    ///        price down (token0 in): net0 = l * (1/c1 - 1/c0)
    ///      and its fee is `net * numerator / denominator` from `lpFeeRate`, which accounts for any protocol fee.
    ///      A token0 fee is valued at `s1`, the pool price after the swap. Rounds DOWN.
    /// @param l Sleeve liquidity.
    /// @param s0 Square-root price before the swap (Q64.96).
    /// @param s1 Square-root price after the swap (Q64.96).
    /// @param lower Lower square-root price bound of the sleeve (Q64.96).
    /// @param upper Upper square-root price bound of the sleeve (Q64.96).
    /// @param numerator LP fee rate numerator from `lpFeeRate`.
    /// @param denominator LP fee rate denominator from `lpFeeRate`.
    /// @return fee The sleeve's fee in raw token1 units, rounded down.
    function swapFee(
        uint128 l,
        uint160 s0,
        uint160 s1,
        uint160 lower,
        uint160 upper,
        uint256 numerator,
        uint256 denominator
    ) internal pure returns (uint256 fee) {
        if (numerator == 0) return 0;
        uint160 c0 = clip(s0, lower, upper);
        uint160 c1 = clip(s1, lower, upper);
        if (c0 == c1) return 0;
        if (c1 > c0) {
            uint256 net1 = FullMath.mulDiv(l, c1 - c0, Q96);
            fee = FullMath.mulDiv(net1, numerator, denominator);
        } else {
            // l * (c0 - c1) * 2^96 / (c0 * c1)
            uint256 net0 = FullMath.mulDiv(FullMath.mulDiv(l, c0 - c1, c1), Q96, c0);
            fee = token0ToToken1(FullMath.mulDiv(net0, numerator, denominator), s1);
        }
    }

    /// @notice Value a token0 amount in token1 at a square-root price: `amount0 * (s / 2^96)^2`. Rounds DOWN.
    /// @param amount0 Raw token0 amount.
    /// @param s Square-root price (Q64.96).
    /// @return amount1 Raw token1 value.
    function token0ToToken1(uint256 amount0, uint160 s) internal pure returns (uint256 amount1) {
        amount1 = FullMath.mulDiv(FullMath.mulDiv(amount0, s, Q96), s, Q96);
    }

    /// @dev Clip both marks and return the earlier clipped mark and the absolute clipped move.
    function _clippedMove(uint160 s0, uint160 s1, uint160 lower, uint160 upper)
        private
        pure
        returns (uint256 c0, uint256 d)
    {
        uint160 a = clip(s0, lower, upper);
        uint160 b = clip(s1, lower, upper);
        c0 = a;
        d = b > a ? b - a : a - b;
    }
}
