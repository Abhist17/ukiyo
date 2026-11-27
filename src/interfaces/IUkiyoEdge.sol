// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IUkiyoEdge
/// @author Abhist Kamle
/// @notice The read side of UkiyoHook, for contracts that pay, rank or gate curators on Edge (a fee splitter, a
///         lending market that takes vault shares, a curator registry) without importing the hook and its Uniswap v4
///         dependencies. UkiyoHook implements every function here; test/UkiyoHook.t.sol checks it through this
///         interface.
/// @dev Money is in raw units of the pool's token1. Edge moves only when the hook books a block, so the Edge earned
///      over a period is `edge` at its end minus `edge` at its start: snapshot it, as UkiyoVault does each epoch.
interface IUkiyoEdge {
    /// @notice Running totals for one sleeve. Edge = userFees + userImpact - arbLoss; arbFees is reported, never
    ///         counted, because pool-marked arbitrage loss already has those fees netted out.
    /// @param userFees LP fees from swaps classified as user flow.
    /// @param userImpact Credit for user price impact that arbitrage later reverts.
    /// @param arbLoss Rebalancing loss between consecutive post-arbitrage marks.
    /// @param arbFees LP fees from swaps classified as arbitrage.
    struct Ledger {
        uint256 userFees;
        uint256 userImpact;
        uint256 arbLoss;
        uint256 arbFees;
    }

    /// @notice Number of sleeves (curators) in the pool.
    function sleeveCount() external view returns (uint256);

    /// @notice A sleeve's Edge so far: user fees + user impact - arbitrage loss.
    function edge(uint256 sleeveId) external view returns (int256);

    /// @notice A sleeve's running totals.
    function ledger(uint256 sleeveId) external view returns (Ledger memory);

    /// @notice The contract (a curator vault) that controls a sleeve, or zero.
    function sleeveManager(uint256 sleeveId) external view returns (address);

    /// @notice A recent post-arbitrage mark the current transaction cannot have set: a price safe to act on.
    function referenceSqrtPrice() external view returns (uint160);

    /// @notice Latest block with a swap, so with a mark.
    function lastMarkedBlock() external view returns (uint256);

    /// @notice Tip per gas at or above which a swap is booked as arbitrage.
    function priorityFeeThreshold() external view returns (uint256);
}
