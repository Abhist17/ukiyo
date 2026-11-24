// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {UkiyoLens} from "../src/UkiyoLens.sol";

/// @title DeployLens
/// @notice Deploys `UkiyoLens` beside an existing deployment and records it in `web/src/deployments/<chainId>.json`.
///         The lens is stateless, so it needs no redeploy of the hook or the vaults.
contract DeployLens is Script {
    /// @notice Deploys the lens and writes its address into the deployment file.
    function run() external {
        vm.startBroadcast();
        UkiyoLens lens = new UkiyoLens();
        vm.stopBroadcast();
        string memory path = string.concat("web/src/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(vm.toString(address(lens)), path, ".lens");
        console2.log("lens", address(lens));
    }
}
