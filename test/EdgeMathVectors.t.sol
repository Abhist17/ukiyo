// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

import {EdgeMath} from "../src/libraries/EdgeMath.sol";

/// @notice Cross-language check: the TypeScript SDK (`sdk/src/math.ts`) wrote `sdk/test/vectors.json`, and every vector
///         must come out of the Solidity libraries to the same wei. Off-chain tools that recompute or audit Ukiyo's
///         ledgers with the SDK therefore agree with the hook exactly, rounding included.
/// @dev Regenerate the file with `cd sdk && npm run vectors`; the SDK's own test fails if it is stale.
contract EdgeMathVectorsTest is Test {
    string internal json;

    function setUp() public {
        json = vm.readFile("sdk/test/vectors.json");
    }

    /// @notice TickMath.getSqrtPriceAtTick, including both ends of the tick range.
    function test_vectors_sqrtPriceAtTick() public view {
        int256[] memory ticks = vm.parseJsonIntArray(json, ".ticks.tick");
        uint256[] memory want = vm.parseJsonUintArray(json, ".ticks.sqrtPriceX96");
        assertEq(ticks.length, want.length);
        assertGt(ticks.length, 100);
        for (uint256 i; i < ticks.length; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            assertEq(TickMath.getSqrtPriceAtTick(int24(ticks[i])), want[i], "tick");
        }
    }

    /// @notice EdgeMath.lpFeeRate, with and without a protocol fee, and at a 100% fee.
    function test_vectors_lpFeeRate() public view {
        uint256[] memory lp = vm.parseJsonUintArray(json, ".feeRates.lpFee");
        uint256[] memory protocol = vm.parseJsonUintArray(json, ".feeRates.protocolFee");
        uint256[] memory num = vm.parseJsonUintArray(json, ".feeRates.numerator");
        uint256[] memory den = vm.parseJsonUintArray(json, ".feeRates.denominator");
        for (uint256 i; i < lp.length; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            (uint256 n, uint256 d) = EdgeMath.lpFeeRate(uint24(lp[i]), uint16(protocol[i]));
            assertEq(n, num[i], "numerator");
            assertEq(d, den[i], "denominator");
        }
    }

    /// @dev The case columns of the vector file.
    struct Cases {
        uint256[] l;
        uint256[] s0;
        uint256[] s1;
        uint256[] lower;
        uint256[] upper;
        uint256[] fee;
        uint256[] loss;
        uint256[] credit;
        uint256[] swapFee;
        uint256[] num;
        uint256[] den;
    }

    /// @notice rebalancingLoss, impactCredit and swapFee on 400 random sleeves and moves, inside and outside ranges.
    function test_vectors_edgeMath() public view {
        Cases memory c;
        c.l = vm.parseJsonUintArray(json, ".cases.l");
        c.s0 = vm.parseJsonUintArray(json, ".cases.s0");
        c.s1 = vm.parseJsonUintArray(json, ".cases.s1");
        c.lower = vm.parseJsonUintArray(json, ".cases.lower");
        c.upper = vm.parseJsonUintArray(json, ".cases.upper");
        c.fee = vm.parseJsonUintArray(json, ".cases.fee");
        c.loss = vm.parseJsonUintArray(json, ".cases.loss");
        c.credit = vm.parseJsonUintArray(json, ".cases.credit");
        c.swapFee = vm.parseJsonUintArray(json, ".cases.swapFee");
        c.num = vm.parseJsonUintArray(json, ".feeRates.numerator");
        c.den = vm.parseJsonUintArray(json, ".feeRates.denominator");
        assertGe(c.l.length, 400);
        for (uint256 i; i < c.l.length; ++i) {
            _check(c, i);
        }
    }

    /// @dev One case through all three formulas.
    function _check(Cases memory c, uint256 i) internal pure {
        // the generator draws l below 2^110 and prices from getSqrtPriceAtTick, so these casts are exact
        // forge-lint: disable-start(unsafe-typecast)
        uint128 l = uint128(c.l[i]);
        uint160 a = uint160(c.s0[i]);
        uint160 b = uint160(c.s1[i]);
        uint160 lo = uint160(c.lower[i]);
        uint160 hi = uint160(c.upper[i]);
        // forge-lint: disable-end(unsafe-typecast)
        assertEq(EdgeMath.rebalancingLoss(l, a, b, lo, hi), c.loss[i], "loss");
        assertEq(EdgeMath.impactCredit(l, a, b, lo, hi), c.credit[i], "credit");
        assertEq(EdgeMath.swapFee(l, a, b, lo, hi, c.num[c.fee[i]], c.den[c.fee[i]]), c.swapFee[i], "swapFee");
    }
}
