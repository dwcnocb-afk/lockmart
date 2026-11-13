// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {LockMarket} from "../src/LockMarket.sol";

/// @notice Deploys LockMarket to Mezo testnet (chain 31611).
/// Required env: PRIVATE_KEY
/// Optional env: FEE_RECIPIENT (defaults to the deployer), FEE_BPS (defaults to 100 = 1%)
contract DeployLockMarket is Script {
    // Mezo testnet addresses (verified on the testnet explorer)
    address constant VEMEZO = 0xaCE816CA2bcc9b12C59799dcC5A959Fb9b98111b;
    address constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;

    function run() external returns (LockMarket market) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(100));

        require(block.chainid == 31611, "Run against Mezo testnet (chain 31611)");
        require(feeRecipient != address(0), "FEE_RECIPIENT is zero");

        vm.startBroadcast(pk);
        market = new LockMarket(VEMEZO, MUSD, feeBps, feeRecipient);
        vm.stopBroadcast();

        require(market.veMEZO() == VEMEZO, "veMEZO mismatch");
        require(market.musd() == MUSD, "MUSD mismatch");
        require(market.feeBps() == feeBps, "feeBps mismatch");
        require(market.feeRecipient() == feeRecipient, "feeRecipient mismatch");

        console2.log("LockMarket:", address(market));
        console2.log("feeRecipient:", feeRecipient);
        console2.log("feeBps:", feeBps);
        console2.log("Put LockMarket address into frontend/src/lib/contracts.ts (TESTNET_ADDRESSES.LockMarket)");
    }
}
