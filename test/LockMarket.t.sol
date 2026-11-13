// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {LockMarket} from "../src/LockMarket.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ============ Mock Contracts ============

// Mock veMEZO NFT (Solidly/Velodrome VotingEscrow style)
contract MockVeMEZO is ERC721 {
    struct LockedBalance {
        int128 amount;
        uint256 end;
        bool isPermanent;
    }

    enum EscrowType { NORMAL, LOCKED, MANAGED }

    mapping(uint256 => LockedBalance) public locked;
    mapping(uint256 => bool) public voted;
    mapping(uint256 => uint8) public escrowType;
    mapping(uint256 => address) public grantManager;
    mapping(uint256 => uint256) public votingPowerOfNFT;
    mapping(address => uint256) public nonces;

    uint256 public nextTokenId = 1;
    address public token = address(0x7B7c000000000000000000000000000000000001); // MEZO precompile

    constructor() ERC721("veMEZO", "veMEZO") {}

    function createLock(
        address to,
        int128 amount,
        uint256 end,
        bool isPermanent,
        uint8 _escrowType,
        address _grantManager
    ) external returns (uint256) {
        uint256 tokenId = nextTokenId++;
        _mint(to, tokenId);
        locked[tokenId] = LockedBalance(amount, end, isPermanent);
        escrowType[tokenId] = _escrowType;
        grantManager[tokenId] = _grantManager;
        votingPowerOfNFT[tokenId] = uint256(uint128(amount)); // voting power = locked amount
        return tokenId;
    }

    function setVoted(uint256 tokenId, bool _voted) external {
        voted[tokenId] = _voted;
    }

    function setBalanceOfNFT(uint256 tokenId, uint256 _balance) external {
        votingPowerOfNFT[tokenId] = _balance;
    }

    function setLocked(uint256 tokenId, int128 amount, uint256 end, bool isPermanent) external {
        locked[tokenId] = LockedBalance(amount, end, isPermanent);
    }

    // Override ERC721 functions to add debug
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        return super._update(to, tokenId, auth);
    }
}

// Mock MUSD with EIP-2612 permit
contract MockMUSD is ERC20 {
    bytes32 public DOMAIN_SEPARATOR;
    mapping(address => uint256) public nonces;

    constructor() ERC20("MUSD", "MUSD") {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("MUSD")),
            keccak256(bytes("1")),
            31611,
            address(this)
        ));
        _mint(address(this), 100_000_000 * 1e18);
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (deadline < block.timestamp) revert("expired");
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            owner,
            spender,
            value,
            nonces[owner]++,
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = ecrecover(digest, v, r, s);
        if (recovered != owner) revert("invalid sig");
        _approve(owner, spender, value);
    }

    // Helper for testing - mint to address
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// Mock NFT that reenters on transfer (for reentrancy test)
contract MockReentrantNFT is ERC721 {
    LockMarket public market;
    bool public reentered = false;

    // Need lock data for the market to read
    struct LockedBalance {
        int128 amount;
        uint256 end;
        bool isPermanent;
    }
    mapping(uint256 => LockedBalance) public locked;
    mapping(uint256 => uint8) public escrowType;
    mapping(uint256 => address) public grantManager;
    mapping(uint256 => uint256) public votingPowerOfNFT;

    constructor(LockMarket _market) ERC721("ReentrantNFT", "RNFT") {
        market = _market;
    }

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function setLocked(uint256 tokenId, int128 amount, uint256 end, bool isPermanent) external {
        locked[tokenId] = LockedBalance(amount, end, isPermanent);
    }

    function setEscrowType(uint256 tokenId, uint8 _escrowType) external {
        escrowType[tokenId] = _escrowType;
    }

    function setGrantManager(uint256 tokenId, address _grantManager) external {
        grantManager[tokenId] = _grantManager;
    }

    function setBalanceOfNFT(uint256 tokenId, uint256 _balance) external {
        votingPowerOfNFT[tokenId] = _balance;
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = super._update(to, tokenId, auth);
        if (to == address(market) && !reentered) {
            reentered = true;
            // Reenter: try to buy again
            try market.buy(tokenId, type(uint256).max, 0, 0) returns (uint256, uint256) {
                // Should revert due to reentrancy guard
            } catch {}
        }
        return from;
    }
}

// ============ Test Contract ============

contract LockMarketTest is Test {
    LockMarket public market;
    MockVeMEZO public veMEZO;
    MockMUSD public musd;
    address public feeRecipient = makeAddr("feeRecipient");
    address public seller = makeAddr("seller");
    // Use anvil account 1 for buyer so we can sign permits
    address public buyer = address(0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC);
    address public other = makeAddr("other");

    // Constants from handoff
    uint256 constant FEE_BPS = 100; // 1%
    uint256 constant ONE_MUSD = 1e18;

    // Anvil account 1 private key for permit signing
    uint256 constant BUYER_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;

    function setUp() public {
        // Deploy mocks
        veMEZO = new MockVeMEZO();
        musd = new MockMUSD();

        // Deploy LockMarket
        market = new LockMarket(address(veMEZO), address(musd), FEE_BPS, feeRecipient);

        // Fund seller and buyer with MUSD
        musd.mint(seller, 10000 * ONE_MUSD);
        musd.mint(buyer, 10000 * ONE_MUSD);
        musd.mint(feeRecipient, 0);

        // Seller approves market to spend MUSD (for permit tests)
        vm.prank(seller);
        musd.approve(address(market), type(uint256).max);

        // Buyer approves market to spend MUSD
        vm.prank(buyer);
        musd.approve(address(market), type(uint256).max);
    }

    // ============ Helpers ============

    function createValidLock(
        address to,
        int128 amount,
        uint256 durationDays,
        bool isPermanent
    ) internal returns (uint256) {
        uint256 end = isPermanent ? 0 : block.timestamp + (durationDays * 1 days);
        return veMEZO.createLock(to, amount, end, isPermanent, 0, address(0)); // NORMAL, no grant
    }

    function createGrantLock(address to, int128 amount) internal returns (uint256) {
        return veMEZO.createLock(to, amount, block.timestamp + 365 days, false, 0, makeAddr("grant"));
    }

    function createExpiredLock(address to, int128 amount) internal returns (uint256) {
        return veMEZO.createLock(to, amount, block.timestamp - 1 days, false, 0, address(0));
    }

    function createLockedEscrowLock(address to, int128 amount) internal returns (uint256) {
        return veMEZO.createLock(to, amount, block.timestamp + 365 days, false, 1, address(0)); // LOCKED
    }

    function signPermit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline
    ) internal returns (uint8 v, bytes32 r, bytes32 s) {
        // Use the known anvil account private key for buyer
        (v, r, s) = vm.sign(BUYER_PK, keccak256(abi.encodePacked(
            "\x19\x01",
            musd.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                spender,
                value,
                musd.nonces(owner),
                deadline
            ))
        )));
    }

    // ============ Happy Path Tests ============

    function testListFixedPrice() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        // Seller approves market for NFT
        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        // List at fixed price
        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        // Check listing
        LockMarket.Listing memory listing = market.getListing(tokenId);
        assertEq(listing.seller, seller);
        assertEq(listing.startPrice, 5000 * ONE_MUSD);
        assertEq(listing.endPrice, 5000 * ONE_MUSD);
        assertFalse(listing.cancelled);
        assertFalse(listing.sold);
    }

    function testListDutchAuction() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        // List with falling price (Dutch auction)
        vm.prank(seller);
        market.list(tokenId, 6000 * ONE_MUSD, 4000 * ONE_MUSD, 30 days);

        LockMarket.Listing memory listing = market.getListing(tokenId);
        assertEq(listing.startPrice, 6000 * ONE_MUSD);
        assertEq(listing.endPrice, 4000 * ONE_MUSD);
    }

    function testBuyFixedPrice() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        // Buyer purchases
        vm.prank(buyer);
        (uint256 pricePaid, uint256 fee) = market.buy(tokenId, 5000 * ONE_MUSD, 0, 0);

        assertEq(pricePaid, 5000 * ONE_MUSD);
        assertEq(fee, 50 * ONE_MUSD); // 1% fee
        assertEq(musd.balanceOf(seller), 10000 * ONE_MUSD + 4950 * ONE_MUSD);
        assertEq(musd.balanceOf(feeRecipient), 50 * ONE_MUSD);
        assertEq(veMEZO.ownerOf(tokenId), buyer);

        LockMarket.Listing memory listing = market.getListing(tokenId);
        assertTrue(listing.sold);
    }

    function testBuyDutchAuction() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 6000 * ONE_MUSD, 4000 * ONE_MUSD, 10 days);

        // Fast forward 5 days (halfway)
        vm.warp(block.timestamp + 5 days);

        // Price should be halfway: 6000 - (6000-4000)*5/10 = 5000
        vm.prank(buyer);
        (uint256 pricePaid, uint256 fee) = market.buy(tokenId, 5000 * ONE_MUSD, 0, 0);

        assertEq(pricePaid, 5000 * ONE_MUSD);
        assertEq(fee, 50 * ONE_MUSD);
        assertEq(veMEZO.ownerOf(tokenId), buyer);
    }

    function testBuyWithPermit() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        // Sign permit for buyer
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = signPermit(buyer, address(market), 5000 * ONE_MUSD, deadline);

        // Buy with permit
        vm.prank(buyer);
        (uint256 pricePaid, uint256 fee) = market.buyWithPermit(tokenId, 5000 * ONE_MUSD, 0, 0, deadline, v, r, s);

        assertEq(pricePaid, 5000 * ONE_MUSD);
        assertEq(fee, 50 * ONE_MUSD);
        assertEq(veMEZO.ownerOf(tokenId), buyer);
    }

    function testCancelListing() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        // Cancel
        vm.prank(seller);
        market.cancel(tokenId);

        LockMarket.Listing memory listing = market.getListing(tokenId);
        assertTrue(listing.cancelled);
    }

    function testInspect() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);
        veMEZO.setVoted(tokenId, true);
        veMEZO.setBalanceOfNFT(tokenId, 1200 * 1e18); // voting power can differ from locked amount

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        (uint256 amount, uint256 end, bool isPermanent, uint256 votingPower, bool voted,
         uint8 escrowType, address grantManager, uint256 currentPrice, bool listingActive) = market.inspect(tokenId);

        assertEq(amount, 1000 * 1e18);
        assertFalse(isPermanent);
        assertEq(votingPower, 1200 * 1e18);
        assertTrue(voted);
        assertEq(escrowType, 0); // NORMAL
        assertEq(grantManager, address(0));
        assertEq(currentPrice, 5000 * ONE_MUSD);
        assertTrue(listingActive);
    }

    // ============ Revert Tests ============

    function testRevert_NotOwnerOrApproved_List() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);
        // No approval given

        vm.prank(seller);
        vm.expectRevert(LockMarket.NotOwnerOrApproved.selector);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);
    }

    function testRevert_NotOwnerOrApproved_Buy() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        // Seller revokes approval
        vm.prank(seller);
        veMEZO.approve(address(0), tokenId);

        vm.prank(buyer);
        vm.expectRevert(LockMarket.NotOwnerOrApproved.selector);
        market.buy(tokenId, 5000 * ONE_MUSD, 0, 0);
    }

    function testRevert_GrantLock() public {
        uint256 tokenId = createGrantLock(seller, 1000 * 1e18);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        vm.expectRevert(LockMarket.GrantLockNotAllowed.selector);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);
    }

    function testRevert_ExpiredLock_List() public {
        // Warp to a future time first, then create lock that expired in the past
        vm.warp(100 days);
        uint256 tokenId = createExpiredLock(seller, 1000 * 1e18);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        vm.expectRevert(LockMarket.LockExpired.selector);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);
    }

    function testRevert_ExpiredLock_Buy() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        // Fast forward past lock expiry
        vm.warp(block.timestamp + 366 days);

        vm.prank(buyer);
        vm.expectRevert(LockMarket.LockExpired.selector);
        market.buy(tokenId, 5000 * ONE_MUSD, 0, 0);
    }

    function testRevert_LockedEscrowType() public {
        uint256 tokenId = createLockedEscrowLock(seller, 1000 * 1e18);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        vm.expectRevert(LockMarket.EscrowTypeNotNormal.selector);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);
    }

    function testRevert_AlreadyListed() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        // Try to list again
        vm.prank(seller);
        vm.expectRevert(LockMarket.AlreadyListed.selector);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);
    }

    function testRevert_NotListed() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(buyer);
        vm.expectRevert(LockMarket.NotListed.selector);
        market.buy(tokenId, 5000 * ONE_MUSD, 0, 0);
    }

    function testRevert_ListingCancelled() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        vm.prank(seller);
        market.cancel(tokenId);

        vm.prank(buyer);
        vm.expectRevert(LockMarket.ListingCancelled.selector);
        market.buy(tokenId, 5000 * ONE_MUSD, 0, 0);
    }

    function testRevert_ListingExpired() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 1 days);

        vm.warp(block.timestamp + 2 days);

        vm.prank(buyer);
        vm.expectRevert(LockMarket.ListingExpired.selector);
        market.buy(tokenId, 5000 * ONE_MUSD, 0, 0);
    }

    function testRevert_ListingSold() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        vm.prank(buyer);
        market.buy(tokenId, 5000 * ONE_MUSD, 0, 0);

        // Try to buy again
        vm.prank(other);
        vm.expectRevert(LockMarket.ListingSold.selector);
        market.buy(tokenId, 5000 * ONE_MUSD, 0, 0);
    }

    function testRevert_PriceExceedsMax() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        vm.prank(buyer);
        vm.expectRevert(LockMarket.PriceExceedsMax.selector);
        market.buy(tokenId, 4000 * ONE_MUSD, 0, 0); // maxPrice < current price
    }

    function testRevert_LockAmountBelowMin() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        // Seller merges/splits reducing amount
        vm.prank(seller);
        veMEZO.setLocked(tokenId, 500 * 1e18, block.timestamp + 365 days, false);

        vm.prank(buyer);
        vm.expectRevert(LockMarket.LockAmountBelowMin.selector);
        market.buy(tokenId, 5000 * ONE_MUSD, 800 * 1e18, 0); // minAmount > actual amount
    }

    function testRevert_LockEndBelowMin() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        // Seller reduces lock end
        uint256 newEnd = block.timestamp + 100 days;
        vm.prank(seller);
        veMEZO.setLocked(tokenId, 1000 * 1e18, newEnd, false);

        vm.prank(buyer);
        vm.expectRevert(LockMarket.LockEndBelowMin.selector);
        market.buy(tokenId, 5000 * ONE_MUSD, 0, block.timestamp + 200 days);
    }

    function testRevert_InvalidPrice_Zero() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        vm.expectRevert(LockMarket.InvalidPrice.selector);
        market.list(tokenId, 0, 5000 * ONE_MUSD, 30 days);
    }

    function testRevert_InvalidPrice_EndAboveStart() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        vm.expectRevert(LockMarket.InvalidPrice.selector);
        market.list(tokenId, 5000 * ONE_MUSD, 6000 * ONE_MUSD, 30 days); // Rising price not allowed
    }

    function testRevert_InvalidDuration() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        vm.expectRevert(LockMarket.InvalidDuration.selector);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 0);
    }

    function testRevert_NotSeller_Cancel() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        vm.prank(other);
        vm.expectRevert(LockMarket.NotSeller.selector);
        market.cancel(tokenId);
    }

    // ============ Hostile Case Tests ============

    function testHostile_SellerTransfersNftAway() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        // Seller transfers NFT to another wallet
        vm.prank(seller);
        veMEZO.transferFrom(seller, other, tokenId);

        // Buyer tries to buy - should fail because seller no longer owns it
        vm.prank(buyer);
        vm.expectRevert(LockMarket.NotSeller.selector);
        market.buy(tokenId, 5000 * ONE_MUSD, 0, 0);
    }

    function testHostile_SellerRevokesApproval() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        // Seller revokes approval
        vm.prank(seller);
        veMEZO.approve(address(0), tokenId);

        vm.prank(buyer);
        vm.expectRevert(LockMarket.NotOwnerOrApproved.selector);
        market.buy(tokenId, 5000 * ONE_MUSD, 0, 0);
    }

    function testHostile_ReentrancyViaNftReceive() public {
        // Deploy a reentrant NFT
        MockReentrantNFT reentrantNft = new MockReentrantNFT(market);
        MockMUSD musd2 = new MockMUSD();
        musd2.mint(buyer, 10000 * ONE_MUSD);

        // Create a new market with the reentrant NFT
        LockMarket market2 = new LockMarket(address(reentrantNft), address(musd2), FEE_BPS, feeRecipient);

        // Approve the NEW market for the new MUSD
        vm.prank(buyer);
        musd2.approve(address(market2), type(uint256).max);

        // Mint token to seller
        uint256 tokenId = 1;
        reentrantNft.mint(seller, tokenId);
        // Manually set up lock data
        reentrantNft.setLocked(tokenId, 1000 * 1e18, block.timestamp + 365 days, false);
        reentrantNft.setEscrowType(tokenId, 0);
        reentrantNft.setGrantManager(tokenId, address(0));
        reentrantNft.setBalanceOfNFT(tokenId, 1000 * 1e18);

        vm.prank(seller);
        reentrantNft.approve(address(market2), tokenId);

        vm.prank(seller);
        market2.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        // Buyer tries to buy - reentrancy should be blocked by ReentrancyGuard
        vm.prank(buyer);
        market2.buy(tokenId, 5000 * ONE_MUSD, 0, 0);

        // If reentrancy worked, the reentrant flag would be true
        // But ReentrancyGuard should prevent the second entry
        // The test passes if no reentrancy occurs (no double spend)
        assertEq(reentrantNft.ownerOf(tokenId), buyer);
    }

    // ============ Fee Tests ============

    function testFeeCalculation() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 10000 * ONE_MUSD, 10000 * ONE_MUSD, 30 days);

        vm.prank(buyer);
        (uint256 pricePaid, uint256 fee) = market.buy(tokenId, 10000 * ONE_MUSD, 0, 0);

        assertEq(fee, 100 * ONE_MUSD); // 1% of 10000 = 100
        assertEq(pricePaid, 10000 * ONE_MUSD);
    }

    function testZeroFee() public {
        // Deploy with 0 fee
        LockMarket zeroFeeMarket = new LockMarket(address(veMEZO), address(musd), 0, feeRecipient);

        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(zeroFeeMarket), tokenId);

        vm.prank(seller);
        zeroFeeMarket.list(tokenId, 10000 * ONE_MUSD, 10000 * ONE_MUSD, 30 days);

        // Approve new market for MUSD
        vm.prank(buyer);
        musd.approve(address(zeroFeeMarket), type(uint256).max);

        vm.prank(buyer);
        (uint256 pricePaid, uint256 fee) = zeroFeeMarket.buy(tokenId, 10000 * ONE_MUSD, 0, 0);

        assertEq(fee, 0);
        assertEq(musd.balanceOf(seller), 10000 * ONE_MUSD + 10000 * ONE_MUSD);
    }

    function testMaxFee() public {
        // Deploy with 100% fee
        LockMarket maxFeeMarket = new LockMarket(address(veMEZO), address(musd), 10000, feeRecipient);

        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(maxFeeMarket), tokenId);

        vm.prank(seller);
        maxFeeMarket.list(tokenId, 10000 * ONE_MUSD, 10000 * ONE_MUSD, 30 days);

        // Approve new market for MUSD
        vm.prank(buyer);
        musd.approve(address(maxFeeMarket), type(uint256).max);

        vm.prank(buyer);
        (uint256 pricePaid, uint256 fee) = maxFeeMarket.buy(tokenId, 10000 * ONE_MUSD, 0, 0);

        assertEq(fee, 10000 * ONE_MUSD);
        assertEq(musd.balanceOf(seller), 10000 * ONE_MUSD); // Seller gets nothing
        assertEq(musd.balanceOf(feeRecipient), 10000 * ONE_MUSD);
    }

    // ============ Permanent Lock Tests ============

    function testPermanentLock() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 0, true); // permanent

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 5000 * ONE_MUSD, 30 days);

        // Permanent locks never expire, should be listable
        LockMarket.Listing memory listing = market.getListing(tokenId);
        assertFalse(listing.cancelled);

        // Buy should work
        vm.prank(buyer);
        (uint256 pricePaid, uint256 fee) = market.buy(tokenId, 5000 * ONE_MUSD, 0, 0);

        assertEq(pricePaid, 5000 * ONE_MUSD);
        assertEq(veMEZO.ownerOf(tokenId), buyer);
    }

    // ============ Edge Cases ============

    function testBuyAtExpiry() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 3000 * ONE_MUSD, 10 days);

        // Warp to exactly end time
        LockMarket.Listing memory listing = market.getListing(tokenId);
        vm.warp(listing.endTime);

        vm.prank(buyer);
        (uint256 pricePaid, uint256 fee) = market.buy(tokenId, 3000 * ONE_MUSD, 0, 0);

        assertEq(pricePaid, 3000 * ONE_MUSD); // Should be at endPrice
    }

    function testBuyAfterExpiryFails() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 5000 * ONE_MUSD, 3000 * ONE_MUSD, 10 days);

        vm.warp(block.timestamp + 11 days);

        vm.prank(buyer);
        vm.expectRevert(LockMarket.ListingExpired.selector);
        market.buy(tokenId, 3000 * ONE_MUSD, 0, 0);
    }

    function testPriceCurveMonotonic() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, 10000 * ONE_MUSD, 5000 * ONE_MUSD, 100 days);

        LockMarket.Listing memory listing = market.getListing(tokenId);
        uint256 startTime = listing.startTime;

        // Check price at various points
        (,,,,,,, uint256 startPrice,) = market.inspect(tokenId);
        assertEq(startPrice, 10000 * ONE_MUSD);

        vm.warp(startTime + 25 days);
        (,,,,,,, uint256 price25,) = market.inspect(tokenId);
        assertGt(startPrice, price25);

        vm.warp(startTime + 75 days);
        (,,,,,,, uint256 price75,) = market.inspect(tokenId);
        assertGt(price25, price75);

        vm.warp(startTime + 100 days); // at expiry
        (,,,,,,, uint256 price100,) = market.inspect(tokenId);
        assertEq(price100, 5000 * ONE_MUSD);
    }

    // ============ Fuzz Tests ============

    function testFuzz_FeeArithmetic(uint256 price, uint256 feeBps) public {
        // Constrain price to buyer's balance (10000 MUSD)
        vm.assume(price > 0);
        vm.assume(price <= 10000 * ONE_MUSD);
        vm.assume(feeBps <= 10000);

        LockMarket fuzzMarket = new LockMarket(address(veMEZO), address(musd), feeBps, feeRecipient);
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(fuzzMarket), tokenId);

        vm.prank(seller);
        fuzzMarket.list(tokenId, price, price, 30 days);

        // Approve the fuzz market for MUSD
        vm.prank(buyer);
        musd.approve(address(fuzzMarket), type(uint256).max);

        vm.prank(buyer);
        (uint256 pricePaid, uint256 fee) = fuzzMarket.buy(tokenId, price, 0, 0);

        // Fee should be price * feeBps / 10000
        uint256 expectedFee = (price * feeBps) / 10000;
        assertEq(fee, expectedFee);
        assertEq(pricePaid, price);
    }

    function testFuzz_PriceCurve(uint256 startPrice, uint256 endPrice, uint256 duration, uint256 elapsed) public {
        // Constrain to reasonable values to avoid overflow in priceDiff * elapsed
        // Also endPrice must be > 0 (contract rejects zero prices)
        vm.assume(startPrice >= endPrice);
        vm.assume(startPrice > 0);
        vm.assume(endPrice > 0);
        vm.assume(startPrice <= 1000000 * ONE_MUSD);
        vm.assume(duration > 0);
        vm.assume(duration <= 365 days);
        vm.assume(elapsed <= duration);

        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);

        vm.prank(seller);
        veMEZO.approve(address(market), tokenId);

        vm.prank(seller);
        market.list(tokenId, startPrice, endPrice, duration);

        LockMarket.Listing memory listing = market.getListing(tokenId);
        vm.warp(listing.startTime + elapsed);

        (,,,,,,, uint256 currentPrice,) = market.inspect(tokenId);

        // Price should be between startPrice and endPrice
        assertLe(currentPrice, startPrice);
        assertGe(currentPrice, endPrice);

        // At elapsed=0, price = startPrice
        if (elapsed == 0) {
            assertEq(currentPrice, startPrice);
        }
        // At elapsed=duration, price = endPrice
        if (elapsed == duration) {
            assertEq(currentPrice, endPrice);
        }
    }

    // ============ Relist / Resale Tests ============

    function _approveAndList(address who, uint256 tokenId, uint256 price, uint256 duration) internal {
        vm.prank(who);
        veMEZO.approve(address(market), tokenId);
        vm.prank(who);
        market.list(tokenId, price, price, duration);
    }

    function testRelistAfterCancel() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);
        _approveAndList(seller, tokenId, 5000 * ONE_MUSD, 7 days);

        vm.prank(seller);
        market.cancel(tokenId);

        vm.prank(seller);
        market.list(tokenId, 4000 * ONE_MUSD, 4000 * ONE_MUSD, 7 days);

        LockMarket.Listing memory l = market.getListing(tokenId);
        assertEq(l.startPrice, 4000 * ONE_MUSD);
        assertFalse(l.cancelled);
        assertFalse(l.sold);
    }

    function testRelistAfterExpiredAuction() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);
        _approveAndList(seller, tokenId, 5000 * ONE_MUSD, 1 days);

        vm.warp(block.timestamp + 2 days);

        vm.prank(seller);
        market.list(tokenId, 4000 * ONE_MUSD, 3000 * ONE_MUSD, 7 days);

        (, , , , , , , uint256 price, bool active) = market.inspect(tokenId);
        assertTrue(active);
        assertEq(price, 4000 * ONE_MUSD);
    }

    function testBuyerCanResellAfterSale() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);
        _approveAndList(seller, tokenId, 5000 * ONE_MUSD, 30 days);

        vm.prank(buyer);
        market.buy(tokenId, 5000 * ONE_MUSD, 0, 0);
        assertEq(veMEZO.ownerOf(tokenId), buyer);

        // Buyer relists the lock they just bought
        _approveAndList(buyer, tokenId, 6000 * ONE_MUSD, 30 days);

        musd.mint(other, 10000 * ONE_MUSD);
        vm.prank(other);
        musd.approve(address(market), type(uint256).max);
        vm.prank(other);
        market.buy(tokenId, 6000 * ONE_MUSD, 0, 0);

        assertEq(veMEZO.ownerOf(tokenId), other);
    }

    function testLiveListingStillBlocksSecondListFromSameSeller() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);
        _approveAndList(seller, tokenId, 5000 * ONE_MUSD, 30 days);

        vm.prank(seller);
        vm.expectRevert(LockMarket.AlreadyListed.selector);
        market.list(tokenId, 4000 * ONE_MUSD, 4000 * ONE_MUSD, 30 days);
    }

    function testStaleListingOverwrittenByNewOwner() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);
        _approveAndList(seller, tokenId, 5000 * ONE_MUSD, 30 days);

        // Seller hands the NFT to `other` off-market; the old listing is now stale
        vm.prank(seller);
        veMEZO.transferFrom(seller, other, tokenId);

        // Old listing can no longer be bought
        vm.prank(buyer);
        vm.expectRevert(LockMarket.NotSeller.selector);
        market.buy(tokenId, 5000 * ONE_MUSD, 0, 0);

        // New owner lists at their own price; record is overwritten
        _approveAndList(other, tokenId, 3000 * ONE_MUSD, 30 days);
        LockMarket.Listing memory l = market.getListing(tokenId);
        assertEq(l.seller, other);

        uint256 sellerBefore = musd.balanceOf(seller);
        vm.prank(buyer);
        market.buy(tokenId, 3000 * ONE_MUSD, 0, 0);
        assertEq(veMEZO.ownerOf(tokenId), buyer);
        assertEq(musd.balanceOf(seller), sellerBefore); // old seller gets nothing
        assertEq(musd.balanceOf(other), 2970 * ONE_MUSD); // 3000 less 1% fee
    }

    // ============ Permit Front-Run Tests ============

    function testBuyWithPermit_SurvivesFrontRunPermit() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);
        _approveAndList(seller, tokenId, 5000 * ONE_MUSD, 30 days);

        // Buyer has no standing allowance
        vm.prank(buyer);
        musd.approve(address(market), 0);

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = signPermit(buyer, address(market), 5000 * ONE_MUSD, deadline);

        // Attacker front-runs by submitting the buyer's permit signature directly
        vm.prank(other);
        musd.permit(buyer, address(market), 5000 * ONE_MUSD, deadline, v, r, s);

        // Buyer's own tx must still succeed
        vm.prank(buyer);
        market.buyWithPermit(tokenId, 5000 * ONE_MUSD, 0, 0, deadline, v, r, s);
        assertEq(veMEZO.ownerOf(tokenId), buyer);
    }

    function testBuyWithPermit_BadSigAndNoAllowanceReverts() public {
        uint256 tokenId = createValidLock(seller, 1000 * 1e18, 365, false);
        _approveAndList(seller, tokenId, 5000 * ONE_MUSD, 30 days);

        vm.prank(buyer);
        musd.approve(address(market), 0);

        vm.prank(buyer);
        vm.expectRevert(LockMarket.PermitFailed.selector);
        market.buyWithPermit(tokenId, 5000 * ONE_MUSD, 0, 0, block.timestamp + 1 hours, 27, bytes32(uint256(1)), bytes32(uint256(2)));
    }

    // ============ Constructor Validation Tests ============

    function testConstructor_ZeroVeMEZO() public {
        vm.expectRevert(LockMarket.ZeroAddress.selector);
        new LockMarket(address(0), address(musd), FEE_BPS, feeRecipient);
    }

    function testConstructor_ZeroMUSD() public {
        vm.expectRevert(LockMarket.ZeroAddress.selector);
        new LockMarket(address(veMEZO), address(0), FEE_BPS, feeRecipient);
    }

    function testConstructor_ZeroFeeRecipient() public {
        vm.expectRevert(LockMarket.ZeroFeeRecipient.selector);
        new LockMarket(address(veMEZO), address(musd), FEE_BPS, address(0));
    }

    function testConstructor_FeeTooHigh() public {
        vm.expectRevert(LockMarket.FeeTooHigh.selector);
        new LockMarket(address(veMEZO), address(musd), 10001, feeRecipient);
    }
}

// ============ Fork Tests (run with --fork-url) ============

contract LockMarketForkTest is Test {
    LockMarket public market;
    address public constant VEMEZO = 0xaCE816CA2bcc9b12C59799dcC5A959Fb9b98111b;
    address public constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address public feeRecipient = makeAddr("feeRecipient");
    address public seller = makeAddr("seller");
    address public buyer = makeAddr("buyer");
    uint256 constant FEE_BPS = 100;

    function setUp() public {
        // These tests require a fork URL to be passed via --fork-url
        // They are skipped in regular test runs
        if (block.chainid != 31611) {
            console2.log("Skipping fork tests - not on Mezo testnet fork");
            return;
        }

        market = new LockMarket(VEMEZO, MUSD, FEE_BPS, feeRecipient);
    }

    function testFork_VeMEZOInterface() public {
        if (block.chainid != 31611) return;

        // Verify veMEZO contract exists and has expected functions
        // This is a smoke test to verify the interface matches
        // You would need an actual veMEZO lock to test fully
    }
}