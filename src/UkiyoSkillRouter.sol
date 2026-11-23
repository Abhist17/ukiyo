// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {UkiyoFactory} from "./UkiyoFactory.sol";
import {UkiyoVault} from "./UkiyoVault.sol";

/// @title UkiyoSkillRouter
/// @author Abhist Kamle
/// @notice One deposit, split across curators by evidence of skill. The scoreboard decides where the money goes.
///
/// @dev Each vault's weight is its skill test, `edgeTStat()`: the t-statistic of its per-epoch Edge returns, which
///      grows with both the size and the consistency of a curator's Edge. Negative statistics count as zero and the
///      statistic is capped at `MAX_T`, so one curator with a short, perfect record cannot take everything. A curator on
///      probation gets nothing. While no vault has a positive statistic there is no evidence to follow, so the deposit
///      splits evenly between the vaults not on probation.
///
///      The router never holds anyone's capital. It escrows each slice in its vault with `requestDepositFor`, so the
///      depositor owns every resulting share directly, gets each vault's refund, and can cancel or redeem in each vault
///      as usual. A vault that cannot take its slice (its epoch is full, or the slice is below its minimum) is skipped,
///      and the slice goes straight back to the depositor.
// The router's job is calling each listed vault, so it calls (and, for a bad list, reverts) inside loops; every loop is
// bounded by MAX_VAULTS, and every callee is a pool token or an eligible vault.
// forge-lint: disable-start(calls-loop)
// forge-lint: disable-start(require-revert-in-loop)
contract UkiyoSkillRouter {
    using SafeERC20 for IERC20;

    /// @notice Cap on a vault's skill weight (a t-statistic of 10, scaled by 1e18).
    uint256 public constant MAX_T = 10e18;

    /// @notice Most vaults one deposit can be split across, which bounds its gas.
    uint256 public constant MAX_VAULTS = 8;

    /// @notice The factory whose launched vaults are eligible.
    UkiyoFactory public immutable factory;

    /// @notice The pool's token0.
    IERC20 public immutable token0;

    /// @notice The pool's token1.
    IERC20 public immutable token1;

    /// @notice Whether `vault` is one of the deployment's own vaults, eligible beside the factory's.
    mapping(address vault => bool) public isCore;

    /// @notice A deposit was split: `amounts0[i]`/`amounts1[i]` went to `vaults[i]` for `depositor`.
    event Routed(address indexed depositor, address[] vaults, uint256[] amounts0, uint256[] amounts1);

    /// @notice The vault is neither a core vault nor launched by the factory.
    error NotEligible(address vault);

    /// @notice The same vault is listed twice, or the list is empty or too long.
    error BadVaultList();

    /// @notice Every listed vault is on probation.
    error NoVaultOpen();

    /// @notice Nothing to deposit.
    error ZeroAmount();

    /// @param factory_ The factory whose vaults are eligible.
    /// @param core The deployment's own vaults (set up by the hook owner rather than the factory).
    constructor(UkiyoFactory factory_, address[] memory core) {
        factory = factory_;
        address hook = address(factory_.hook());
        for (uint256 i; i < core.length; ++i) {
            // a core vault must curate the factory's pool, or its shares would be in other tokens
            if (address(UkiyoVault(core[i]).hook()) != hook) revert NotEligible(core[i]);
            isCore[core[i]] = true;
        }
        // fee, spacing and hooks are not needed here
        // forge-lint: disable-next-line(unused-return)
        (Currency c0, Currency c1,,,) = factory_.hook().poolKey();
        token0 = IERC20(Currency.unwrap(c0));
        token1 = IERC20(Currency.unwrap(c1));
    }

    /// @notice Whether a deposit may be routed to `vault`.
    function isEligible(address vault) public view returns (bool) {
        return isCore[vault] || factory.isLaunched(vault);
    }

    /// @notice How a deposit would be split, in bps of it, summing to 10,000.
    /// @param vaults Candidate vaults, each eligible and listed once.
    /// @return w Each vault's share, in bps.
    function weights(UkiyoVault[] calldata vaults) public view returns (uint256[] memory w) {
        uint256 n = vaults.length;
        if (n == 0 || n > MAX_VAULTS) revert BadVaultList();
        w = new uint256[](n);
        uint256 total = 0;
        uint256 open = 0;
        for (uint256 i; i < n; ++i) {
            address v = address(vaults[i]);
            if (!isEligible(v)) revert NotEligible(v);
            for (uint256 k; k < i; ++k) {
                if (address(vaults[k]) == v) revert BadVaultList();
            }
            if (vaults[i].onProbation()) continue;
            ++open;
            int256 t = vaults[i].edgeTStat();
            uint256 score = t <= 0 ? 0 : Math.min(SafeCast.toUint256(t), MAX_T);
            w[i] = score;
            total += score;
        }
        if (open == 0) revert NoVaultOpen();
        // no evidence of skill anywhere yet: split evenly between the open vaults
        if (total == 0) {
            for (uint256 i; i < n; ++i) {
                if (!vaults[i].onProbation()) w[i] = 1;
            }
            total = open;
        }
        // scale to bps; the rounding remainder goes to the heaviest vault, which always has a weight
        uint256 sum = 0;
        uint256 top = 0;
        uint256 topRaw = 0;
        for (uint256 i; i < n; ++i) {
            uint256 raw = w[i];
            if (raw > topRaw) (top, topRaw) = (i, raw);
            w[i] = raw * 10_000 / total;
            sum += w[i];
        }
        w[top] += 10_000 - sum;
    }

    /// @notice Split a deposit across `vaults` by `weights`, escrowing each slice in its vault for the caller. Approve
    ///         this router for both tokens first. Slices settle with each vault's epoch, like a direct deposit.
    /// @param vaults Candidate vaults, each eligible and listed once.
    /// @param amount0 token0 to deposit.
    /// @param amount1 token1 to deposit.
    /// @return amounts0 token0 escrowed in each vault (0 where skipped).
    /// @return amounts1 token1 escrowed in each vault.
    function deposit(UkiyoVault[] calldata vaults, uint256 amount0, uint256 amount1)
        external
        returns (uint256[] memory amounts0, uint256[] memory amounts1)
    {
        if (amount0 == 0 && amount1 == 0) revert ZeroAmount();
        uint256[] memory w = weights(vaults);
        uint256 n = vaults.length;
        amounts0 = new uint256[](n);
        amounts1 = new uint256[](n);
        if (amount0 != 0) token0.safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 != 0) token1.safeTransferFrom(msg.sender, address(this), amount1);

        uint256 used0 = 0;
        uint256 used1 = 0;
        for (uint256 i; i < n; ++i) {
            if (w[i] == 0) continue;
            uint256 x0 = amount0 * w[i] / 10_000;
            uint256 x1 = amount1 * w[i] / 10_000;
            if (x0 == 0 && x1 == 0) continue;
            UkiyoVault v = vaults[i];
            token0.forceApprove(address(v), x0);
            token1.forceApprove(address(v), x1);
            // a vault whose epoch is full, or for which the slice is too small, is skipped; its slice is returned
            try v.requestDepositFor(msg.sender, x0, x1) {
                amounts0[i] = x0;
                amounts1[i] = x1;
                used0 += x0;
                used1 += x1;
            } catch {
                token0.forceApprove(address(v), 0);
                token1.forceApprove(address(v), 0);
            }
        }
        // rounding dust and skipped slices go back to the depositor
        if (amount0 > used0) token0.safeTransfer(msg.sender, amount0 - used0);
        if (amount1 > used1) token1.safeTransfer(msg.sender, amount1 - used1);

        address[] memory list = new address[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = address(vaults[i]);
        }
        // the only callees are the two pool tokens and eligible vaults
        // forge-lint: disable-next-line(reentrancy-events)
        emit Routed(msg.sender, list, amounts0, amounts1);
    }
}
// forge-lint: disable-end(require-revert-in-loop)
// forge-lint: disable-end(calls-loop)
