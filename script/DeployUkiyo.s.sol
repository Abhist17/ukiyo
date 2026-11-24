// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {V4PoolManagerDeployer} from "hookmate/artifacts/V4PoolManager.sol";
import {AddressConstants} from "hookmate/constants/AddressConstants.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {UkiyoHook} from "../src/UkiyoHook.sol";
import {UkiyoVault} from "../src/UkiyoVault.sol";
import {UkiyoFactory} from "../src/UkiyoFactory.sol";
import {UkiyoSkillRouter} from "../src/UkiyoSkillRouter.sol";
import {UkiyoLens} from "../src/UkiyoLens.sol";

/// @title DeployUkiyo
/// @notice Deploys the full Ukiyo demo: two faucet test tokens (tBTC, tUSD), the hook at a mined address, a 5 bps
///         hook-exclusive pool at the BTC price the replay starts from, one sleeve and one curator vault per strategy,
///         seed deposits, a swap router, the factory through which anyone can launch a further vault, and the skill
///         router that splits a deposit across curators by their skill tests. Writes every address to `web/src/deployments/<chainId>.json`, which the
///         site and the replay bot read.
/// @dev On a chain with a canonical v4 PoolManager (Unichain Sepolia, 1301) it uses that one; on anvil it deploys the
///      canonical bytecode. Environment (all optional):
///        THRESHOLD  priority fee per gas (wei) at or above which a swap is arbitrage   default 0.1 gwei
///        EPOCH      vault epoch length in seconds                                      default 600
///        CURATOR    curator of every vault (the replay bot)                            default the broadcaster
///        PERF_FEE_BPS  performance fee on Edge above the high-water mark               default 1000 (10%)
///        LVR_BUDGET_BPS  each demo curator's LVR budget per epoch                      default 25
///        START_PRICE  tUSD per tBTC                                                    default 42,268 (1 Jan 2024)
///        PROBATION_BPS  Edge-index drawdown that puts a demo curator on probation      default 300 (3%)
///        LAUNCH_BOND  permanent bond the factory requires of a new curator, in tUSD     default 5,000
contract DeployUkiyo is Script {
    /// @dev forge's CREATE2 deployer proxy, the `deployer` HookMiner must mine against.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint24 internal constant FEE = 500; // 5 bps: the tier that tolerates an imperfect classifier
    int24 internal constant SPACING = 10;

    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
    );

    /// @notice One curator strategy: a name and a half-width in ticks around the start price.
    struct Strategy {
        string name;
        string symbol;
        string style;
        int24 halfWidth;
        uint256 bondUsd;
    }

    /// @notice Everything the deployment created, kept in memory to write the JSON at the end.
    struct Deployed {
        address manager;
        MockERC20 btc;
        MockERC20 usd;
        UkiyoHook hook;
        PoolSwapTest router;
        UkiyoFactory factory;
        UkiyoSkillRouter skillRouter;
        UkiyoLens lens;
        PoolKey key;
        UkiyoVault[] vaults;
    }

    /// @notice Deployment settings read from the environment.
    struct Config {
        uint256 threshold;
        uint256 epochLength;
        uint256 startPrice;
        uint256 performanceFeeBps;
        uint256 lvrBudgetBps;
        uint256 probationBps;
        uint256 launchBond;
        address curator;
        address deployer;
    }

    /// @notice Deploys everything and writes the deployment file.
    function run() external {
        Config memory c = Config({
            threshold: vm.envOr("THRESHOLD", uint256(0.1 gwei)),
            epochLength: vm.envOr("EPOCH", uint256(600)),
            startPrice: vm.envOr("START_PRICE", uint256(42_268)),
            performanceFeeBps: vm.envOr("PERF_FEE_BPS", uint256(1000)),
            lvrBudgetBps: vm.envOr("LVR_BUDGET_BPS", uint256(25)),
            probationBps: vm.envOr("PROBATION_BPS", uint256(300)),
            launchBond: vm.envOr("LAUNCH_BOND", uint256(5000 ether)),
            curator: vm.envOr("CURATOR", msg.sender),
            deployer: msg.sender
        });
        Strategy[] memory strategies = _strategies();

        Deployed memory d;
        d.vaults = new UkiyoVault[](strategies.length);

        vm.startBroadcast();
        d.manager = block.chainid == 31_337
            ? V4PoolManagerDeployer.deploy(c.deployer)
            : AddressConstants.getPoolManagerAddress(block.chainid);

        // tUSD must sort after tBTC so it is token1: the hook books Edge in token1, so Edge reads in dollars.
        d.btc = MockERC20(_create2(bytes32(0), _tokenInitCode("Ukiyo Test BTC", "tBTC")));
        d.usd = MockERC20(_create2(_usdSalt(address(d.btc)), _tokenInitCode("Ukiyo Test USD", "tUSD")));

        // The hook's address must carry its permission flags in its low bits.
        bytes memory args = abi.encode(IPoolManager(d.manager), c.deployer, c.threshold);
        (address target, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, HOOK_FLAGS, type(UkiyoHook).creationCode, args);
        d.hook = UkiyoHook(_create2(salt, abi.encodePacked(type(UkiyoHook).creationCode, args)));
        require(address(d.hook) == target, "hook address mismatch");

        bool btcIs0 = address(d.btc) < address(d.usd);
        d.key = PoolKey({
            currency0: Currency.wrap(btcIs0 ? address(d.btc) : address(d.usd)),
            currency1: Currency.wrap(btcIs0 ? address(d.usd) : address(d.btc)),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(d.hook))
        });
        uint160 sqrtPrice = _sqrtPriceX96(c.startPrice, btcIs0);
        IPoolManager(d.manager).initialize(d.key, sqrtPrice);
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtPrice);

        for (uint256 i; i < strategies.length; ++i) {
            d.vaults[i] = _openVault(d, c, strategies[i], tick, btcIs0);
        }

        d.router = new PoolSwapTest(IPoolManager(d.manager));
        // Anyone can launch a further curator vault through the factory, on at least the demo's epoch length.
        d.factory = new UkiyoFactory(d.hook, c.epochLength, c.launchBond, 2000);
        d.hook.setLauncher(address(d.factory));
        // One deposit split across the demo's and any launched curators by their skill tests.
        address[] memory core = new address[](d.vaults.length);
        for (uint256 i; i < core.length; ++i) {
            core[i] = address(d.vaults[i]);
        }
        d.skillRouter = new UkiyoSkillRouter(d.factory, core);
        // the whole scoreboard in one view call, for apps and integrators
        d.lens = new UkiyoLens();
        vm.stopBroadcast();

        _write(d, strategies, c);
    }

    /// @notice Opens one sleeve, hands it to a new vault and queues the seed deposit: 10 tBTC and its worth in tUSD.
    ///         The deposit is minted when the bot settles the vault's first epoch.
    function _openVault(Deployed memory d, Config memory c, Strategy memory s, int24 tick, bool btcIs0)
        internal
        returns (UkiyoVault v)
    {
        uint256 seedBtc = 10 ether;
        uint256 seedUsd = seedBtc * c.startPrice;
        d.btc.mint(c.deployer, seedBtc);
        d.usd.mint(c.deployer, seedUsd);
        uint256 id = d.hook.sleeveCount();
        v = new UkiyoVault(
            d.hook,
            id,
            c.curator,
            UkiyoVault.Terms({
                epochLength: c.epochLength,
                performanceFeeBps: c.performanceFeeBps,
                probationBps: c.probationBps,
                minBond: 0
            }),
            s.name,
            s.symbol
        );
        d.hook.launchSleeve(c.curator, _floor(tick - s.halfWidth), _ceil(tick + s.halfWidth), address(v));
        d.btc.approve(address(v), type(uint256).max);
        d.usd.approve(address(v), type(uint256).max);
        (uint256 a0, uint256 a1) = btcIs0 ? (seedBtc, seedUsd) : (seedUsd, seedBtc);
        v.requestDeposit(a0, a1);
        // When the broadcaster is also the curator (the demo), post the bond and promise a budget.
        if (c.curator == c.deployer && s.bondUsd != 0) {
            d.usd.mint(c.deployer, s.bondUsd);
            v.postBond(s.bondUsd);
            v.setLvrBudget(c.lvrBudgetBps);
        }
    }

    /// @notice Deploy through the CREATE2 deployer proxy explicitly. `new X{salt: ...}` in a script is routed through
    ///         it on some chains and sent from the broadcaster on others (Unichain Sepolia), which would move the
    ///         address away from the one HookMiner mined; calling the proxy makes the address the same everywhere.
    function _create2(bytes32 salt, bytes memory initCode) internal returns (address deployed) {
        // Same salt and code give the same address on every run: if an earlier deployment already put the contract
        // there (the test tokens), reuse it, so balances minted on earlier deployments carry over.
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
        if (predicted.code.length != 0) return predicted;
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok && ret.length == 20, "create2 failed");
        deployed = address(bytes20(ret));
        require(deployed.code.length != 0, "create2 deployed nothing");
    }

    /// @notice Creation code of a test token.
    function _tokenInitCode(string memory name, string memory symbol) internal pure returns (bytes memory) {
        return abi.encodePacked(type(MockERC20).creationCode, abi.encode(name, symbol, uint8(18)));
    }

    /// @notice First CREATE2 salt that puts tUSD at a higher address than tBTC.
    function _usdSalt(address btc) internal pure returns (bytes32 salt) {
        bytes32 initHash = keccak256(_tokenInitCode("Ukiyo Test USD", "tUSD"));
        for (uint256 i;; ++i) {
            salt = bytes32(i);
            if (vm.computeCreate2Address(salt, initHash, CREATE2_DEPLOYER) > btc) return salt;
        }
    }

    /// @notice The demo's curators. Widths follow the backtest's strategies (±25%, ±8%, ±1.5%, ±4%).
    function _strategies() internal pure returns (Strategy[] memory s) {
        s = new Strategy[](4);
        s[0] = Strategy("Ukiyo Passive Wide", "ukWIDE", "Passive wide: 25% each side, never moves", 2230, 25_000 ether);
        s[1] = Strategy("Ukiyo Passive Mid", "ukMID", "Passive mid: 8% each side, never moves", 770, 50_000 ether);
        s[2] = Strategy(
            "Ukiyo Tight Chaser", "ukTIGHT", "Tight chaser: 1.5% each side, recentres on exit", 150, 10_000 ether
        );
        s[3] =
            Strategy("Ukiyo Vol Adaptive", "ukVOL", "Vol-adaptive: width follows recent volatility", 390, 40_000 ether);
    }

    /// @notice sqrt(price) in Q64.96, where price is token1 per token0.
    /// @param usdPerBtc Start price in whole tUSD per tBTC (both tokens have 18 decimals).
    /// @param btcIs0 Whether tBTC is token0.
    function _sqrtPriceX96(uint256 usdPerBtc, bool btcIs0) internal pure returns (uint160) {
        uint256 q192 = 1 << 192;
        return uint160(btcIs0 ? Math.sqrt(usdPerBtc * q192) : Math.sqrt(q192 / usdPerBtc));
    }

    /// @dev Round down to a multiple of the tick spacing (toward negative infinity).
    function _floor(int24 t) internal pure returns (int24) {
        int24 r = (t / SPACING) * SPACING;
        return r > t ? r - SPACING : r;
    }

    /// @dev Round up to a multiple of the tick spacing.
    function _ceil(int24 t) internal pure returns (int24) {
        int24 r = (t / SPACING) * SPACING;
        return r < t ? r + SPACING : r;
    }

    /// @notice Writes the deployment file the site and the bot read.
    function _write(Deployed memory d, Strategy[] memory strategies, Config memory c) internal {
        string[] memory vaults = new string[](d.vaults.length);
        for (uint256 i; i < d.vaults.length; ++i) {
            string memory k = string.concat("vault", vm.toString(i));
            vm.serializeAddress(k, "address", address(d.vaults[i]));
            vm.serializeUint(k, "sleeveId", i);
            vm.serializeString(k, "name", strategies[i].name);
            vm.serializeString(k, "symbol", strategies[i].symbol);
            vaults[i] = vm.serializeString(k, "style", strategies[i].style);
        }

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "deployBlock", block.number);
        vm.serializeAddress(o, "poolManager", d.manager);
        vm.serializeAddress(o, "hook", address(d.hook));
        vm.serializeAddress(o, "router", address(d.router));
        vm.serializeAddress(o, "factory", address(d.factory));
        vm.serializeAddress(o, "skillRouter", address(d.skillRouter));
        vm.serializeAddress(o, "lens", address(d.lens));
        vm.serializeUint(o, "launchBond", c.launchBond);
        vm.serializeUint(o, "probationBps", c.probationBps);
        vm.serializeAddress(o, "token0", Currency.unwrap(d.key.currency0));
        vm.serializeAddress(o, "token1", Currency.unwrap(d.key.currency1));
        vm.serializeAddress(o, "btc", address(d.btc));
        vm.serializeAddress(o, "usd", address(d.usd));
        vm.serializeUint(o, "fee", FEE);
        vm.serializeInt(o, "tickSpacing", SPACING);
        vm.serializeString(o, "threshold", vm.toString(c.threshold));
        vm.serializeUint(o, "epochLength", c.epochLength);
        vm.serializeUint(o, "startPrice", c.startPrice);
        vm.serializeAddress(o, "curator", c.curator);
        vm.serializeUint(o, "performanceFeeBps", c.performanceFeeBps);
        string memory json = vm.serializeString(o, "vaults", vaults);

        string memory path = string.concat("web/src/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("hook", address(d.hook));
        console2.log("wrote", path);
    }
}
