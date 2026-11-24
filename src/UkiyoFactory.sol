// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {UkiyoHook} from "./UkiyoHook.sol";
import {UkiyoVault} from "./UkiyoVault.sol";

/// @title UkiyoFactory
/// @author Abhist Kamle
/// @notice Lets anyone become a Ukiyo curator without the hook owner: one call deploys a genuine `UkiyoVault`, opens its
///         sleeve, hands the sleeve to the vault for good and posts the curator's launch bond.
///
/// @dev Why the vault's code arrives as calldata. `UkiyoVault`'s creation code is close to the 24 KB contract limit, so
///      a factory embedding it would not deploy. The caller sends the code instead, and the factory deploys it only if
///      its hash equals the genuine vault's (taken from `type(UkiyoVault).creationCode` at construction), so a launch
///      can never install anything but a real `UkiyoVault` with the depositor protections below.
///
///      Every launched vault must offer depositors:
///        - epochs of at least `minEpochLength`, so entries and exits settle in batches;
///        - a probation drawdown between 1 bp and `maxProbationBps`, so a curator on a losing streak is stopped;
///        - a permanent bond of at least `minLaunchBond` token1, which the curator can never withdraw. It also prices
///          the hook's limited sleeve slots, so they cannot be filled for free.
contract UkiyoFactory {
    using SafeERC20 for IERC20;

    /// @notice The hook whose pool every launched vault curates.
    UkiyoHook public immutable hook;

    /// @notice keccak256 of `UkiyoVault`'s creation code: the only code `launch` will deploy.
    bytes32 public immutable vaultCodeHash;

    /// @notice The pool's token1, the bond token.
    IERC20 public immutable token1;

    /// @notice Shortest epoch a launched vault may have, in seconds.
    uint256 public immutable minEpochLength;

    /// @notice Smallest permanent bond a launched vault's curator must post, in token1.
    uint256 public immutable minLaunchBond;

    /// @notice Largest probation drawdown a launched vault may choose, in bps of its Edge index.
    uint256 public immutable maxProbationBps;

    /// @notice Every vault launched here, in order.
    address[] public vaults;

    /// @notice Whether `vault` was launched here, so it is a genuine `UkiyoVault` on this factory's terms.
    mapping(address vault => bool) public isLaunched;

    /// @notice A curator launched a vault.
    event VaultLaunched(
        address indexed vault, address indexed curator, uint256 indexed sleeveId, int24 tickLower, int24 tickUpper
    );

    /// @notice The code sent is not `UkiyoVault`'s creation code.
    error NotUkiyoVaultCode();

    /// @notice A term is outside what the factory allows.
    error BadTerms();

    /// @notice Deploying the vault failed.
    error DeployFailed();

    /// @notice The hook opened a different sleeve than the one the vault was built for.
    error SleeveMismatch(uint256 expected, uint256 opened);

    /// @param hook_ The Ukiyo hook; its pool must be initialized. Its owner must then call `setLauncher(factory)`.
    /// @param minEpochLength_ Shortest epoch a launched vault may have, in seconds.
    /// @param minLaunchBond_ Smallest permanent curator bond, in token1.
    /// @param maxProbationBps_ Largest probation drawdown a launched vault may choose, in bps.
    constructor(UkiyoHook hook_, uint256 minEpochLength_, uint256 minLaunchBond_, uint256 maxProbationBps_) {
        if (maxProbationBps_ == 0 || maxProbationBps_ >= 10_000) revert BadTerms();
        hook = hook_;
        vaultCodeHash = keccak256(type(UkiyoVault).creationCode);
        // the other key fields are not needed here
        // forge-lint: disable-next-line(unused-return)
        (, Currency c1,,,) = hook_.poolKey();
        token1 = IERC20(Currency.unwrap(c1));
        minEpochLength = minEpochLength_;
        minLaunchBond = minLaunchBond_;
        maxProbationBps = maxProbationBps_;
    }

    /// @notice Launch a curator vault with the caller as its curator. Pulls `terms.minBond` token1 from the caller as
    ///         the vault's permanent bond, so approve this factory for it first.
    /// @param vaultCode `type(UkiyoVault).creationCode`, exactly (see the contract notes for why it is passed in).
    /// @param tickLower The sleeve's first lower tick.
    /// @param tickUpper The sleeve's first upper tick.
    /// @param terms The vault's terms; must meet this factory's minimums.
    /// @param name Share token name.
    /// @param symbol Share token symbol.
    /// @return vault The new vault.
    function launch(
        bytes calldata vaultCode,
        int24 tickLower,
        int24 tickUpper,
        UkiyoVault.Terms calldata terms,
        string calldata name,
        string calldata symbol
    ) external returns (UkiyoVault vault) {
        if (keccak256(vaultCode) != vaultCodeHash) revert NotUkiyoVaultCode();
        if (
            terms.epochLength < minEpochLength || terms.minBond < minLaunchBond || terms.probationBps == 0
                || terms.probationBps > maxProbationBps
        ) revert BadTerms();

        // The vault is built for the sleeve the hook will open next; checked below.
        uint256 id = hook.sleeveCount();
        // creation code followed by constructor arguments; the result is deployed, never hashed
        // forge-lint: disable-next-line(encode-packed-collision)
        bytes memory init = abi.encodePacked(vaultCode, abi.encode(hook, id, msg.sender, terms, name, symbol));
        address v;
        assembly ("memory-safe") {
            v := create(0, add(init, 0x20), mload(init))
        }
        if (v == address(0)) revert DeployFailed();
        vault = UkiyoVault(v);

        uint256 opened = hook.launchSleeve(msg.sender, tickLower, tickUpper, v);
        if (opened != id) revert SleeveMismatch(id, opened);
        vaults.push(v);
        isLaunched[v] = true;

        // The launch bond goes straight into the vault, where `minBond` keeps it for the vault's life.
        if (terms.minBond != 0) {
            token1.safeTransferFrom(msg.sender, address(this), terms.minBond);
            token1.forceApprove(v, terms.minBond);
            vault.postBond(terms.minBond);
        }
        // the only callees are the hook, the vault just verified as genuine, and the pool's token1
        // forge-lint: disable-next-line(reentrancy-events)
        emit VaultLaunched(v, msg.sender, id, tickLower, tickUpper);
    }

    /// @notice Number of vaults launched here.
    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }
}
