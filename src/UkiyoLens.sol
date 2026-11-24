// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UkiyoHook} from "./UkiyoHook.sol";
import {UkiyoVault} from "./UkiyoVault.sol";

/// @title UkiyoLens
/// @author Abhist Kamle
/// @notice The whole Ukiyo scoreboard in one `view` call: every sleeve's ledger and Edge, and for each sleeve run by a
///         curator vault, the size-neutral Edge index, the skill test, probation and the vault's terms. For apps,
///         aggregators and other vault platforms that want to rank curators by Edge without indexing events.
/// @dev Stateless and permissionless; it holds no funds and reads only. A sleeve whose manager is not a vault of this
///      hook (or that has no manager) is reported with `isVault = false` and the vault fields left at zero.
// The lens's job is reading each sleeve, so it calls the hook and vaults inside a loop: read-only, and bounded by the
// hook's MAX_SLEEVES.
// forge-lint: disable-start(calls-loop)
contract UkiyoLens {
    /// @notice Pool-level state.
    /// @param sqrtPriceX96 Spot square-root price.
    /// @param referenceSqrtPriceX96 The hook's reference price: a post-arbitrage mark the current transaction cannot set.
    /// @param lastPostMark Post-arbitrage mark of the latest marked block.
    /// @param lastMarkedBlock Latest block with a swap.
    /// @param priorityFeeThreshold Tip per gas at or above which a swap is booked as arbitrage.
    /// @param sleeveCount Number of sleeves.
    struct Pool {
        uint160 sqrtPriceX96;
        uint160 referenceSqrtPriceX96;
        uint160 lastPostMark;
        uint256 lastMarkedBlock;
        uint256 priorityFeeThreshold;
        uint256 sleeveCount;
    }

    /// @notice One curator's line on the scoreboard. Money is in raw token1 units; ratios are scaled by 1e18.
    /// @param sleeveId The sleeve.
    /// @param curator Address credited with the sleeve's Edge.
    /// @param manager Contract that controls the sleeve (its vault), or zero.
    /// @param tickLower Lower tick of the sleeve's range.
    /// @param tickUpper Upper tick of the sleeve's range.
    /// @param liquidity The sleeve's liquidity.
    /// @param ledger User fees, user impact, arbitrage loss and arbitrage fees so far.
    /// @param edge User fees + user impact - arbitrage loss.
    /// @param isVault Whether `manager` is a curator vault of this hook, so the fields below are filled.
    /// @param edgeIndex Compounded Edge over the capital that earned it, 1e18 at launch: size-neutral skill.
    /// @param edgeIndexTime Seconds of epochs the index covers.
    /// @param edgeTStat t-statistic of per-epoch Edge returns (1e18 = 1.0).
    /// @param edgeEpochs Epochs the skill test has seen.
    /// @param hasSkill Whether the skill test is at least 2.
    /// @param onProbation Whether the curator is barred from rebalancing after a drawdown.
    /// @param epoch The vault's current epoch.
    /// @param epochEndsAt When the current epoch can be settled.
    /// @param capital The vault's capital at the reference price (`valueAtMark`).
    /// @param totalSupply The vault's share supply.
    /// @param bond The curator's bond.
    /// @param performanceFeeBps The vault's performance fee.
    /// @param name The vault's share name.
    /// @param symbol The vault's share symbol.
    /// @param amount0 token0 the vault holds as capital (idle plus position, at spot).
    /// @param amount1 token1 the vault holds as capital.
    /// @param epochStartEdge The sleeve's Edge when the current epoch began.
    /// @param lvrBudgetBps Negative Edge per epoch, in bps of value, beyond which the bond pays depositors.
    /// @param atHighWater Whether Edge per share is at or above its high-water mark (a fee is due on the next gain).
    /// @param curatorShares Shares the curator holds (its fees, paid in shares).
    struct Row {
        uint256 sleeveId;
        address curator;
        address manager;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        UkiyoHook.Ledger ledger;
        int256 edge;
        bool isVault;
        uint256 edgeIndex;
        uint256 edgeIndexTime;
        int256 edgeTStat;
        uint256 edgeEpochs;
        bool hasSkill;
        bool onProbation;
        uint256 epoch;
        uint256 epochEndsAt;
        uint256 capital;
        uint256 totalSupply;
        uint256 bond;
        uint256 performanceFeeBps;
        string name;
        string symbol;
        uint256 amount0;
        uint256 amount1;
        int256 epochStartEdge;
        uint256 lvrBudgetBps;
        bool atHighWater;
        uint256 curatorShares;
    }

    /// @notice The pool's state and every sleeve's line, in sleeve order.
    /// @param hook The Ukiyo hook to read.
    /// @return pool Pool-level state.
    /// @return rows One row per sleeve.
    function scoreboard(UkiyoHook hook) external view returns (Pool memory pool, Row[] memory rows) {
        uint256 n = hook.sleeveCount();
        pool = Pool({
            sqrtPriceX96: hook.sqrtPriceX96(),
            referenceSqrtPriceX96: hook.referenceSqrtPrice(),
            lastPostMark: hook.lastPostMark(),
            lastMarkedBlock: hook.lastMarkedBlock(),
            priorityFeeThreshold: hook.priorityFeeThreshold(),
            sleeveCount: n
        });
        rows = new Row[](n);
        for (uint256 i; i < n; ++i) {
            rows[i] = row(hook, i);
        }
    }

    /// @notice One sleeve's line.
    /// @param hook The Ukiyo hook to read.
    /// @param sleeveId The sleeve.
    /// @return r The sleeve's line.
    function row(UkiyoHook hook, uint256 sleeveId) public view returns (Row memory r) {
        UkiyoHook.Sleeve memory s = hook.sleeve(sleeveId);
        r.sleeveId = sleeveId;
        r.curator = s.curator;
        r.tickLower = s.tickLower;
        r.tickUpper = s.tickUpper;
        r.liquidity = s.liquidity;
        r.ledger = hook.ledger(sleeveId);
        r.edge = hook.edge(sleeveId);
        address m = hook.sleeveManager(sleeveId);
        r.manager = m;
        if (m == address(0) || m.code.length == 0) return r;
        // a manager counts as a vault only if it says it curates this very sleeve of this very hook
        try UkiyoVault(m).hook() returns (UkiyoHook h) {
            if (address(h) != address(hook) || UkiyoVault(m).sleeveId() != sleeveId) return r;
        } catch {
            return r;
        }
        _fillVault(r, UkiyoVault(m));
    }

    /// @dev The vault half of a row.
    function _fillVault(Row memory r, UkiyoVault v) internal view {
        r.isVault = true;
        r.edgeIndex = v.edgeIndex();
        r.edgeIndexTime = v.edgeIndexTime();
        r.edgeTStat = v.edgeTStat();
        r.edgeEpochs = v.edgeEpochs();
        r.hasSkill = v.hasSkill();
        r.onProbation = v.onProbation();
        r.epoch = v.epoch();
        r.epochEndsAt = v.epochEndsAt();
        r.capital = v.valueAtMark();
        r.totalSupply = v.totalSupply();
        r.bond = v.bond();
        r.performanceFeeBps = v.performanceFeeBps();
        r.name = v.name();
        r.symbol = v.symbol();
        (r.amount0, r.amount1) = v.holdings();
        r.epochStartEdge = v.epochStartEdge();
        r.lvrBudgetBps = v.lvrBudgetBps();
        r.atHighWater = v.edgePerShare() >= v.highWaterMark();
        r.curatorShares = v.balanceOf(v.curator());
    }
}
// forge-lint: disable-end(calls-loop)
