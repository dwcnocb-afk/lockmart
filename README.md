# Lockmart — Non-Custodial veMEZO Lock Marketplace

> **Mezo Buildathon Wave 2 Submission** — A trustless marketplace for veMEZO locks with fair-value valuation, Dutch auctions, and bait-and-switch protection.

## Overview

Lockmart enables veMEZO NFT holders to sell their locks without giving up custody until the atomic sale executes. Buyers get cryptographic guarantees that the lock parameters (amount, expiry) haven't changed since listing.

### Key Features

- **Non-Custodial**: Seller keeps veMEZO NFT in their wallet until `buy()` executes atomically
- **Dutch Auctions**: Falling price listings (linear decay) or fixed price
- **Bait-and-Switch Protection**: Buyers set `minAmount` and `minEnd` — transaction reverts if lock parameters change
- **Grant Lock Exclusion**: Locks with `grantManager != 0` cannot be listed
- **Fair Value Engine**: Transparent valuation = Discounted Principal + MEZO Rebase + veBTC Gauge Incentives
- **EIP-2612 Permit**: Gasless MUSD approval for buyers
- **1% Protocol Fee**: Configurable, paid to fee recipient

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        LockMarket.sol                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   list()    │  │   buy()     │  │  cancel()   │             │
│  │  Dutch/fixed│  │  + permit   │  │  seller only│             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                    │
│         ▼                ▼                ▼                    │
│  ┌─────────────────────────────────────────────┐              │
│  │         _executeBuy() (internal)            │              │
│  │  • Re-verify lock amount/end (bait-and-switch)│            │
│  │  • Check listing active & not expired        │              │
│  │  • Transfer MUSD (with permit support)       │              │
│  │  • Pay fee to feeRecipient                   │              │
│  │  • safeTransferFrom veMEZO to buyer          │              │
│  └─────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│   veMEZO      │    │    MUSD       │    │  Frontend     │
│   (ERC-721)   │    │  (ERC-20 +    │    │  (Next.js +   │
│   Max 4yr lock│    │  EIP-2612)    │    │   wagmi/viem) │
└───────────────┘    └───────────────┘    └───────────────┘
```

---

## Contract Addresses (Mezo Testnet - Matsnet, Chain ID 31611)

| Contract | Address |
|----------|---------|
| veMEZO NFT | `0xaCE816CA2bcc9b12C59799dcC5A959Fb9b98111b` |
| MUSD | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` |
| LockMarket | *Deploy via script* |
| Fee Recipient | *Set at deployment* |

---

## Quick Start

### Prerequisites

- **Foundry** (forge, cast, anvil) — `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- **Node.js 20+** with pnpm — `corepack enable && corepack prepare pnpm@latest --activate`
- **Git**

### 1. Clone & Install

```bash
git clone <your-repo>
cd lockmart

# Install Solidity dependencies
forge install

# Install frontend dependencies
cd frontend && pnpm install && cd ..

# Install valuation engine dependencies
cd valuation && pnpm install && cd ..
```

### 2. Environment Setup

Create `.env` in root:

```bash
# Required for deployment
PRIVATE_KEY=0x...your_deployer_private_key...

# Optional: RPC URLs (defaults to public endpoints)
MATSNET_RPC_URL=https://rpc.test.mezo.org
MEZO_RPC_URL=https://rpc.mezo.org
```

### 3. Run Tests

```bash
# All Solidity tests (41 tests)
forge test

# Valuation engine tests (24 tests)
cd valuation && pnpm test && cd ..

# Frontend type check
cd frontend && pnpm typecheck && cd ..
```

### 4. Deploy to Mezo Testnet

```bash
# Deploy LockMarket
forge script script/DeployLockMarket.s.sol \
  --rpc-url $MATSNET_RPC_URL \
  --broadcast \
  --verify \
  --verifier-url https://explorer.test.mezo.org/api \
  --verifier blockscout
```

**After deployment**, update `frontend/src/lib/contracts.ts` with the deployed addresses:
```typescript
TESTNET_ADDRESSES.LockMarket = "0x...";
TESTNET_ADDRESSES.feeRecipient = "0x...";
```

### 5. Run Frontend

```bash
cd frontend
pnpm dev
# Open http://localhost:3000
```

---

## Smart Contract Details

### LockMarket.sol (~350 lines, immutable)

**State Variables:**
- `veMEZO` — veMEZO NFT contract (immutable)
- `musd` — MUSD token contract (immutable)
- `feeBps` — Protocol fee in basis points (default 100 = 1%)
- `feeRecipient` — Fee recipient address (immutable)

**Struct: Listing**
```solidity
struct Listing {
    uint256 tokenId;
    address seller;
    uint256 startPrice;  // MUSD (18 decimals)
    uint256 endPrice;    // MUSD (18 decimals)
    uint256 startTime;
    uint256 endTime;
    bool cancelled;
    bool sold;
}
```

**Key Functions:**

| Function | Description |
|----------|-------------|
| `list(tokenId, startPrice, endPrice, duration)` | Create listing (seller must own & approve NFT) |
| `cancel(tokenId)` | Cancel active listing (seller only) |
| `buy(tokenId, maxPrice, minAmount, minEnd)` | Buy with MUSD approval |
| `buyWithPermit(...)` | Buy with EIP-2612 permit (gasless approval) |
| `inspect(tokenId)` | View lock data + current price + listing status |
| `getListing(tokenId)` | View listing parameters |

**Bait-and-Switch Protection (in `_executeBuy`):**
```solidity
// Re-verify lock parameters at execution time
(int128 amount, uint256 end, bool isPermanent) = veMEZO.locked(tokenId);
if (uint256(uint128(amount)) < minAmount) revert AmountChanged();
if (!isPermanent && end < minEnd) revert LockExpired();
```

**Grant Lock Exclusion:**
```solidity
if (veMEZO.grantManager(tokenId) != address(0)) revert GrantLockNotAllowed();
```

---

## Valuation Engine

Located in `valuation/src/index.ts`

### Formula

```
Fair Value (MEZO) = Locked Amount × Discount Factor + Rebase Value + Incentive Value

Discount Factor = (1 - annualDiscountRate) ^ yearsRemaining
Rebase Value = Locked Amount × (e^(annualRebaseRate × yearsRemaining) - 1)
Incentive Value = Locked Amount × (annualIncentiveRate × yearsRemaining)  [only if voted]
```

### Default Assumptions (Configurable)

| Parameter | Default | Source |
|-----------|---------|--------|
| Max Lock Years | 4 | veMEZO spec |
| Annual Discount Rate | 16% | Desk pays ~56% for 4yr: (1-r)^4 = 0.56 |
| Annual Rebase Rate | 8% | MEZO emission estimate |
| Annual Incentive Rate | 12% | veBTC gauge incentive estimate |
| Desk Discount (4yr) | 56% | Market observation |
| MEZO/USD Fallback | $0.50 | Rough estimate |

### Usage

```typescript
import { ValuationEngine } from "./valuation";

const engine = new ValuationEngine({
  annualDiscountRate: 0.16,
  annualRebaseRate: 0.08,
  annualIncentiveRate: 0.12,
  fallbackMezoUsdPrice: 0.50,
});

// Optionally update MEZO/USD price from on-chain pools
engine.setMezoUsdPrice(0.52);

const result = engine.evaluate(lockData, listingData);
console.log(result.fairValueUsd, result.deskReferenceUsd, result.premiumOverFair);
```

---

## Frontend Pages

| Route | Description |
|-------|-------------|
| `/` | Browse — All listings with fair value, desk reference, premium/discount |
| `/sell` | Sell — Your locks, eligibility check, create listing (Dutch/fixed) |
| `/lock/:tokenId` | Detail — Full valuation breakdown, buy panel with protection params |
| `/proof` | Proof — Every claim linked to code, tests, and verification |

---

## Testing

### Solidity Tests (41 tests)

```bash
forge test -vvv

# Specific test files
forge test --match-path test/ListAndBuy.t.sol
forge test --match-path test/Listing.t.sol
forge test --match-path test/Security.t.sol
forge test --match-path test/EdgeCases.t.sol
```

**Test Categories:**
- `ListAndBuy.t.sol` — Happy path: list, buy, cancel, permit
- `Listing.t.sol` — Dutch auction math, price bounds, expiry
- `Security.t.sol` — Bait-and-switch, grant exclusion, reentrancy
- `EdgeCases.t.sol` — Fuzz tests, permanent locks, time warps

### TypeScript Tests (24 tests)

```bash
cd valuation && pnpm test
```

---

## Buildathon Submission Checklist

### Smart Contract ✅
- [x] Immutable LockMarket.sol (~350 lines)
- [x] Non-custodial: NFT stays with seller until atomic buy()
- [x] Dutch auction + fixed price listings
- [x] Bait-and-switch protection (re-verify at buy time)
- [x] Grant lock exclusion (grantManager != 0)
- [x] EIP-2612 permit support
- [x] 1% protocol fee to feeRecipient
- [x] 41 comprehensive Foundry tests (all passing)
- [x] Deploy script for Mezo testnet

### Valuation Engine ✅
- [x] TypeScript class with Zod validation
- [x] Discounted principal + rebase + incentives
- [x] Desk reference (56% for 4yr, time-scaled)
- [x] Eligibility checks (escrow, grant, expiry, min time)
- [x] 24 Jest tests (all passing)
- [x] Configurable assumptions for sensitivity analysis

### Frontend ✅
- [x] Next.js 14 + wagmi/viem + Tailwind CSS
- [x] Browse page with fair value comparison
- [x] Sell page with lock selection & listing form
- [x] Lock Detail page with valuation breakdown & buy panel
- [x] Proof page linking claims to code/tests
- [x] Mezo testnet/mainnet wagmi config

### Documentation ✅
- [x] This README with setup/deploy instructions
- [x] Deck text (see `DECK.md`)
- [x] Video script (see `VIDEO_SCRIPT.md`)

### Deployment (You do this)
- [ ] Fund deployer wallet on Matsnet (get MEZO from faucet)
- [ ] Create veMEZO test lock (lock MEZO for 1-4 years)
- [ ] Fund buyer wallet with MUSD (swap MEZO→MUSD on Mezo Pools)
- [ ] Deploy LockMarket via Forge script
- [ ] Update frontend contract addresses
- [ ] Verify on Mezo Explorer
- [ ] Test end-to-end: list → buy → verify ownership transfer

---

## Project Structure

```
lockmart/
├── src/
│   └── LockMarket.sol          # Main contract (~350 lines)
├── test/
│   ├── ListAndBuy.t.sol        # Core flow tests
│   ├── Listing.t.sol           # Listing/auction tests
│   ├── Security.t.sol          # Security tests
│   └── EdgeCases.t.sol         # Fuzz/edge case tests
├── script/
│   └── DeployLockMarket.s.sol  # Deployment script
├── foundry.toml                # Foundry config (via_ir enabled)
├── valuation/
│   ├── src/
│   │   ├── index.ts            # ValuationEngine class
│   │   └── index.test.ts       # 24 tests
│   ├── package.json
│   ├── tsconfig.json
│   └── jest.config.js
├── frontend/
│   ├── src/
│   │   ├── app/                # Next.js App Router pages
│   │   │   ├── page.tsx        # Browse
│   │   │   ├── sell/page.tsx   # Sell
│   │   │   ├── lock/[tokenId]/ # Detail
│   │   │   └── proof/page.tsx  # Proof
│   │   ├── components/         # React components
│   │   ├── hooks/              # wagmi/viem hooks
│   │   ├── lib/                # Config, contracts, valuation
│   │   └── providers.tsx       # Wagmi + React Query providers
│   ├── package.json
│   ├── tsconfig.json
│   └── tailwind.config.ts
├── DECK.md                     # Presentation deck text
├── VIDEO_SCRIPT.md             # 3-min demo video script
└── README.md                   # This file
```

---

## Security Considerations

1. **Non-Custodial**: NFT never leaves seller's wallet until `buy()` executes
2. **Reentrancy**: MUSD transfer happens before NFT transfer (checks-effects-interactions)
3. **Bait-and-Switch**: Lock parameters re-verified at execution time
4. **Grant Locks**: Explicitly rejected at listing time
5. **Expired Locks**: Cannot list expired locks; buy reverts if lock expires before `minEnd`
6. **Price Bounds**: Dutch auction price clamped to `[endPrice, startPrice]`
7. **Immutable Contract**: No admin keys, no upgradeability, no pausing

---

## License

MIT License — See LICENSE file for details.

---

## Links

- **Mezo Testnet Explorer**: https://explorer.test.mezo.org
- **Mezo Testnet RPC**: https://rpc.test.mezo.org
- **Mezo Docs**: https://docs.mezo.org
- **Buildathon Info**: https://buildathon.mezo.org