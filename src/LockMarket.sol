// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title LockMarket
 * @notice Non-custodial marketplace for veMEZO locks
 * @dev Immutable contract: veMEZO, MUSD, fee, feeRecipient fixed at deploy.
 *      No owner, no admin, no upgrade, no pause.
 *      NFT never held by contract; MUSD passes through only in buy().
 */
contract LockMarket is ReentrancyGuard {
    // ============ Immutable Configuration ============
    address public immutable veMEZO;
    address public immutable musd;
    uint256 public immutable feeBps;       // 100 = 1%
    address public immutable feeRecipient;

    // ============ Escrow Types (from tigris) ============
    enum EscrowType { NORMAL, LOCKED, MANAGED }

    // ============ Listing Struct ============
    struct Listing {
        uint256 tokenId;
        address seller;
        uint256 startPrice;   // Price at listing start (MUSD, 18 decimals)
        uint256 endPrice;     // Price at listing end (MUSD, 18 decimals)
        uint256 startTime;    // Listing start timestamp
        uint256 endTime;      // Listing end timestamp (expiry)
        bool cancelled;
        bool sold;
    }

    // ============ State ============
    mapping(uint256 => Listing) public listings;
    // One LIVE listing per tokenId per seller. A listing stops being live when it is
    // cancelled, sold, past its endTime, or its seller no longer owns the NFT; the
    // current owner may then list again (the old record is overwritten).

    // ============ Events ============
    event Listed(uint256 indexed tokenId, address indexed seller, uint256 startPrice, uint256 endPrice, uint256 duration);
    event Cancelled(uint256 indexed tokenId, address indexed seller);
    event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 fee);

    // ============ Errors ============
    error ZeroAddress();
    error ZeroFeeRecipient();
    error FeeTooHigh();              // > 10000 bps (100%)
    error InvalidPrice();
    error InvalidDuration();
    error NotOwnerOrApproved();
    error NotSeller();
    error AlreadyListed();
    error NotListed();
    error ListingCancelled();
    error ListingExpired();
    error ListingSold();
    error PriceExceedsMax();
    error LockAmountBelowMin();
    error LockEndBelowMin();
    error EscrowTypeNotNormal();
    error GrantLockNotAllowed();
    error LockExpired();
    error TransferFailed();
    error PermitFailed();

    // ============ Constructor ============
    constructor(
        address _veMEZO,
        address _musd,
        uint256 _feeBps,
        address _feeRecipient
    ) {
        if (_veMEZO == address(0)) revert ZeroAddress();
        if (_musd == address(0)) revert ZeroAddress();
        if (_feeBps > 10000) revert FeeTooHigh();
        if (_feeRecipient == address(0)) revert ZeroFeeRecipient();

        veMEZO = _veMEZO;
        musd = _musd;
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
    }

    // ============ Internal: veMEZO Interface Instance ============
    function _ve() internal view returns (IVotingEscrow) {
        return IVotingEscrow(veMEZO);
    }

    function _musdToken() internal view returns (IMUSD) {
        return IMUSD(musd);
    }

    // ============ Internal: Eligibility Checks ============
    function _checkEligibility(uint256 tokenId, address expectedSeller) internal view {
        IVotingEscrow ve = _ve();

        // 1. Check escrow type is NORMAL (0)
        if (ve.escrowType(tokenId) != uint8(EscrowType.NORMAL)) {
            revert EscrowTypeNotNormal();
        }

        // 2. Check not a grant lock (grantManager == address(0))
        if (ve.grantManager(tokenId) != address(0)) {
            revert GrantLockNotAllowed();
        }

        // 3. Check lock not expired (for non-permanent locks)
        (int128 amount, uint256 end, bool isPermanent) = ve.locked(tokenId);
        if (!isPermanent && end <= block.timestamp) {
            revert LockExpired();
        }

        // 4. Check ownership
        if (expectedSeller != address(0) && ve.ownerOf(tokenId) != expectedSeller) {
            revert NotSeller();
        }

        // 5. Check seller has approved this contract
        address approved = ve.getApproved(tokenId);
        bool approvedForAll = ve.isApprovedForAll(expectedSeller, address(this));
        if (approved != address(this) && !approvedForAll) {
            revert NotOwnerOrApproved();
        }
    }

    // ============ Internal: Is a listing still live? ============
    function _isLive(Listing storage l) internal view returns (bool) {
        return l.seller != address(0) && !l.cancelled && !l.sold && block.timestamp <= l.endTime;
    }

    // ============ Internal: Calculate Current Price ============
    function _currentPrice(Listing storage listing) internal view returns (uint256) {
        if (listing.startPrice == listing.endPrice) {
            return listing.startPrice;
        }
        if (block.timestamp >= listing.endTime) {
            return listing.endPrice;
        }
        if (block.timestamp <= listing.startTime) {
            return listing.startPrice;
        }
        // Linear interpolation: price = startPrice - (startPrice - endPrice) * (elapsed / duration)
        uint256 elapsed = block.timestamp - listing.startTime;
        uint256 duration = listing.endTime - listing.startTime;
        uint256 priceDiff = listing.startPrice - listing.endPrice;
        return listing.startPrice - (priceDiff * elapsed) / duration;
    }

    // ============ Public: List a Lock ============
    /**
     * @notice List a veMEZO lock for sale
     * @param tokenId The veMEZO NFT token ID
     * @param startPrice Starting price in MUSD (18 decimals)
     * @param endPrice Ending price in MUSD (18 decimals). If equal to startPrice, fixed price.
     * @param duration Listing duration in seconds. Must be > 0.
     */
    function list(
        uint256 tokenId,
        uint256 startPrice,
        uint256 endPrice,
        uint256 duration
    ) external {
        if (startPrice == 0 || endPrice == 0) revert InvalidPrice();
        if (endPrice > startPrice) revert InvalidPrice(); // Only fixed or falling (Dutch)
        if (duration == 0) revert InvalidDuration();

        address seller = msg.sender;

        // Eligibility checks at list time
        _checkEligibility(tokenId, seller);

        // Reject only if THIS seller already has a live listing for the token.
        // Cancelled / sold / expired / stale (seller no longer owner) records can be
        // replaced, so a bought lock can be resold and an unsold auction can be relisted.
        Listing storage existing = listings[tokenId];
        if (_isLive(existing) && existing.seller == seller) {
            revert AlreadyListed();
        }

        uint256 currentTime = block.timestamp;
        listings[tokenId] = Listing({
            tokenId: tokenId,
            seller: seller,
            startPrice: startPrice,
            endPrice: endPrice,
            startTime: currentTime,
            endTime: currentTime + duration,
            cancelled: false,
            sold: false
        });

        emit Listed(tokenId, seller, startPrice, endPrice, duration);
    }

    // ============ Public: Cancel a Listing ============
    function cancel(uint256 tokenId) external {
        Listing storage listing = listings[tokenId];
        if (listing.seller == address(0)) revert NotListed();
        if (msg.sender != listing.seller) revert NotSeller();
        if (listing.cancelled) revert ListingCancelled();
        if (listing.sold) revert ListingSold();

        listing.cancelled = true;
        emit Cancelled(tokenId, msg.sender);
    }

    // ============ Internal: Execute Purchase ============
    function _executeBuy(
        uint256 tokenId,
        uint256 maxPrice,
        uint256 minAmount,
        uint256 minEnd
    ) internal nonReentrant returns (uint256 pricePaid, uint256 feeAmount) {
        Listing storage listing = listings[tokenId];
        if (listing.seller == address(0)) revert NotListed();
        if (listing.cancelled) revert ListingCancelled();
        if (listing.sold) revert ListingSold();

        address seller = listing.seller;

        // Re-check eligibility at buy time (bait-and-switch protection)
        // This includes lock expiry check - must come before listing expiry
        _checkEligibility(tokenId, seller);

        // Verify lock parameters haven't been reduced (merge/split protection)
        (int128 amount, uint256 end, bool isPermanent) = _ve().locked(tokenId);
        if (uint256(uint128(amount)) < minAmount) revert LockAmountBelowMin();
        if (!isPermanent && end < minEnd) revert LockEndBelowMin();

        // Calculate current price
        uint256 currentPrice = _currentPrice(listing);
        if (currentPrice > maxPrice) revert PriceExceedsMax();

        // Check listing expiry AFTER lock eligibility (lock expiry takes precedence)
        if (block.timestamp > listing.endTime) revert ListingExpired();

        // Calculate fee
        feeAmount = (currentPrice * feeBps) / 10000;
        uint256 sellerAmount = currentPrice - feeAmount;

        // Mark as sold BEFORE transfers (checks-effects-interactions)
        listing.sold = true;

        // Transfer MUSD from buyer to seller + fee recipient using transferFrom
        // Buyer must have approved this contract to spend their MUSD
        IMUSD musdToken = _musdToken();
        if (sellerAmount > 0) {
            bool sent = musdToken.transferFrom(msg.sender, seller, sellerAmount);
            if (!sent) revert TransferFailed();
        }
        if (feeAmount > 0) {
            bool sent = musdToken.transferFrom(msg.sender, feeRecipient, feeAmount);
            if (!sent) revert TransferFailed();
        }

        // Transfer NFT from seller to buyer
        _ve().safeTransferFrom(seller, msg.sender, tokenId);

        pricePaid = currentPrice;
        emit Sold(tokenId, seller, msg.sender, currentPrice, feeAmount);
    }

    // ============ Public: Buy with MUSD Transfer ============
    /**
     * @notice Buy a listed lock, paying with MUSD
     * @param tokenId The veMEZO NFT token ID
     * @param maxPrice Maximum price willing to pay (MUSD, 18 decimals)
     * @param minAmount Minimum locked MEZO amount expected
     * @param minEnd Minimum lock end timestamp expected (0 = no minimum)
     */
    function buy(
        uint256 tokenId,
        uint256 maxPrice,
        uint256 minAmount,
        uint256 minEnd
    ) external returns (uint256 pricePaid, uint256 feeAmount) {
        // transferFrom in _executeBuy will revert if allowance is insufficient
        return _executeBuy(tokenId, maxPrice, minAmount, minEnd);
    }

    // ============ Public: Buy with EIP-2612 Permit ============
    /**
     * @notice Buy a listed lock using MUSD permit (single signature)
     * @param tokenId The veMEZO NFT token ID
     * @param maxPrice Maximum price willing to pay (MUSD, 18 decimals)
     * @param minAmount Minimum locked MEZO amount expected
     * @param minEnd Minimum lock end timestamp expected (0 = no minimum)
     * @param deadline Permit deadline
     * @param v Permit v
     * @param r Permit r
     * @param s Permit s
     */
    function buyWithPermit(
        uint256 tokenId,
        uint256 maxPrice,
        uint256 minAmount,
        uint256 minEnd,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 pricePaid, uint256 feeAmount) {
        IMUSD musdToken = _musdToken();
        uint256 currentPrice = _currentPrice(listings[tokenId]);

        // Execute permit. If someone front-ran the permit signature (nonce already used),
        // the call reverts; that is harmless as long as the allowance already covers the price.
        try musdToken.permit(msg.sender, address(this), currentPrice, deadline, v, r, s) {
            // Permit succeeded
        } catch {
            if (musdToken.allowance(msg.sender, address(this)) < currentPrice) {
                revert PermitFailed();
            }
        }

        return _executeBuy(tokenId, maxPrice, minAmount, minEnd);
    }

    // ============ View: Inspect Listing + Lock ============
    /**
     * @notice Get full lock + listing info for UI
     * @return amount Locked MEZO amount
     * @return end Lock end timestamp
     * @return isPermanent Whether lock is permanent
     * @return votingPower Current voting power (votingPowerOfNFT; 0 if the call fails)
     * @return voted Whether lock has voted in current epoch
     * @return escrowType Escrow type (0=NORMAL, 1=LOCKED, 2=MANAGED)
     * @return grantManager Grant manager address (0 = not a grant lock)
     * @return currentPrice Current listing price (0 if not listed)
     * @return listingActive Whether listing exists and is active
     */
    function inspect(uint256 tokenId) external view returns (
        uint256 amount,
        uint256 end,
        bool isPermanent,
        uint256 votingPower,
        bool voted,
        uint8 escrowType,
        address grantManager,
        uint256 currentPrice,
        bool listingActive
    ) {
        IVotingEscrow ve = _ve();
        (int128 amt, uint256 lockEnd, bool perm) = ve.locked(tokenId);
        amount = uint256(uint128(amt));
        end = lockEnd;
        isPermanent = perm;
        // Mezo's veMEZO exposes votingPowerOfNFT (not balanceOfNFT). Never let it break inspect().
        try ve.votingPowerOfNFT(tokenId) returns (uint256 vp) {
            votingPower = vp;
        } catch {
            votingPower = 0;
        }
        voted = ve.voted(tokenId);
        escrowType = uint8(ve.escrowType(tokenId));
        grantManager = ve.grantManager(tokenId);

        Listing storage listing = listings[tokenId];
        if (listing.seller != address(0) && !listing.cancelled && !listing.sold && block.timestamp <= listing.endTime) {
            currentPrice = _currentPrice(listing);
            listingActive = true;
        } else {
            currentPrice = 0;
            listingActive = false;
        }
    }

    // ============ View: Get Listing ============
    function getListing(uint256 tokenId) external view returns (Listing memory) {
        return listings[tokenId];
    }
}

// ============ External Interfaces ============
// Minimal interface matching the deployed VotingEscrow (Solidly/Velodrome style)
interface IVotingEscrow {
    function ownerOf(uint256 tokenId) external view returns (address);
    function locked(uint256 tokenId) external view returns (int128 amount, uint256 end, bool isPermanent);
    function votingPowerOfNFT(uint256 tokenId) external view returns (uint256);
    function voted(uint256 tokenId) external view returns (bool);
    function escrowType(uint256 tokenId) external view returns (uint8);
    function grantManager(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
}

// MUSD Interface (ERC20 + EIP-2612)
interface IMUSD is IERC20 {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
    function nonces(address owner) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}