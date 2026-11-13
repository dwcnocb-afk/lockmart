/**
 * Lockmart Valuation Engine
 *
 * Fair-value calculation for veMEZO locks on Mezo.
 * All assumptions are explicit and configurable.
 *
 * Formula: Fair Value (MEZO) = Locked Amount × Discount Factor + Rebase Value + Incentive Value
 *
 * Discount Factor = (1 - annualDiscountRate) ^ yearsRemaining
 * Rebase Value = Locked Amount × (e^(rebaseRate × yearsRemaining) - 1)
 * Incentive Value = Locked Amount × (incentiveAPY × yearsRemaining)
 *
 * Calibration: Desk pays ~56% for 4-year lock → ~16% effective annual discount
 */

import { z } from "zod";

// ============ Configuration Schema ============

export const ValuationConfigSchema = z.object({
  // Time assumptions
  maxLockYears: z.number().default(4),           // veMEZO max lock = 4 years (1460 days)
  secondsPerYear: z.number().default(365 * 24 * 60 * 60),

  // Discount rate (market-derived)
  // Desk pays ~56% for 4-year lock → (1 - r)^4 = 0.56 → r ≈ 0.16
  annualDiscountRate: z.number().min(0).max(1).default(0.16),  // 16% per year

  // MEZO emission rebase (adjust based on current MEZO emissions)
  // MEZO has a fixed emission schedule; rebase rate = emissions / totalSupply
  annualRebaseRate: z.number().min(0).max(1).default(0.08),    // 8% per year (estimate)

  // veBTC gauge incentives (boosted by veMEZO)
  // veMEZO boosts veBTC voting power up to 5x
  // Incentive APY depends on voted gauges
  annualIncentiveRate: z.number().min(0).max(1).default(0.12), // 12% per year (estimate)

  // Price source
  // "mezo-only" = values in MEZO terms only
  // "pools" = use Mezo Pools router for MEZO/USD quote (requires RPC)
  priceMode: z.enum(["mezo-only", "pools"]).default("mezo-only"),

  // MEZO/USD price (used if priceMode = "pools" but RPC unavailable)
  fallbackMezoUsdPrice: z.number().default(0.50), // $0.50/MEZO estimate

  // Desk reference (for UI comparison)
  deskDiscount4Year: z.number().default(0.56),   // Desk pays 56% of face for 4-year

  // Minimum remaining time to list (seconds)
  minRemainingTime: z.number().default(7 * 24 * 60 * 60), // 1 week
});

export type ValuationConfig = z.infer<typeof ValuationConfigSchema>;

// ============ Input Types ============

export const LockDataSchema = z.object({
  tokenId: z.number(),
  amount: z.number(),           // Locked MEZO amount (already adjusted for decimals)
  end: z.number(),              // Lock end timestamp (0 = permanent)
  isPermanent: z.boolean(),
  votingPower: z.number(),      // Current voting power (votingPowerOfNFT)
  voted: z.boolean(),           // Whether voted in current epoch
  escrowType: z.number(),       // 0=NORMAL, 1=LOCKED, 2=MANAGED
  grantManager: z.string(),     // Address (0 = not a grant lock)
  currentPrice: z.number(),     // Current listing price in MUSD (0 if not listed)
  listingActive: z.boolean(),
});

export type LockData = z.infer<typeof LockDataSchema>;

export const ListingDataSchema = z.object({
  tokenId: z.number(),
  seller: z.string(),
  startPrice: z.number(),       // MUSD
  endPrice: z.number(),         // MUSD
  startTime: z.number(),
  endTime: z.number(),
  cancelled: z.boolean(),
  sold: z.boolean(),
  currentPrice: z.number().optional(),  // Current price from inspect (MUSD)
});

export type ListingData = z.infer<typeof ListingDataSchema>;

// ============ Output Types ============

export const ValuationResultSchema = z.object({
  tokenId: z.number(),

  // Core valuation (in MEZO)
  lockedAmount: z.number(),
  yearsRemaining: z.number(),
  discountFactor: z.number(),
  discountedPrincipal: z.number(),

  // Yield components
  rebaseValue: z.number(),
  incentiveValue: z.number(),

  // Total fair value
  fairValueMezo: z.number(),
  fairValueUsd: z.number(),

  // Desk reference
  deskReferenceMezo: z.number(),
  deskReferenceUsd: z.number(),

  // Listing comparison
  listingPriceMezo: z.number().nullable(),
  listingPriceUsd: z.number().nullable(),
  premiumOverFair: z.number().nullable(),        // (listing - fair) / fair
  discountToDesk: z.number().nullable(),         // (desk - listing) / desk

  // Metadata
  isPermanent: z.boolean(),
  voted: z.boolean(),
  eligible: z.boolean(),
  eligibilityReasons: z.array(z.string()),

  // Assumptions used (for transparency)
  assumptions: ValuationConfigSchema,
});

export type ValuationResult = z.infer<typeof ValuationResultSchema>;

// ============ Valuation Engine ============

export class ValuationEngine {
  private config: ValuationConfig;
  private mezoUsdPrice: number | null = null;

  constructor(config: Partial<ValuationConfig> = {}) {
    this.config = ValuationConfigSchema.parse(config);
  }

  /**
   * Update MEZO/USD price (call after fetching from Pools)
   */
  setMezoUsdPrice(price: number): void {
    this.mezoUsdPrice = price;
  }

  /**
   * Get current MEZO/USD price
   */
  getMezoUsdPrice(): number {
    if (this.config.priceMode === "pools" && this.mezoUsdPrice !== null) {
      return this.mezoUsdPrice;
    }
    return this.config.fallbackMezoUsdPrice;
  }

  /**
   * Calculate years remaining for a lock
   */
  calculateYearsRemaining(end: number, isPermanent: boolean, now: number = Date.now() / 1000): number {
    if (isPermanent || end === 0) {
      return this.config.maxLockYears;
    }
    const remainingSeconds = Math.max(0, end - now);
    return remainingSeconds / this.config.secondsPerYear;
  }

  /**
   * Calculate discount factor: (1 - r)^t
   */
  calculateDiscountFactor(yearsRemaining: number): number {
    return Math.pow(1 - this.config.annualDiscountRate, yearsRemaining);
  }

  /**
   * Calculate rebase value: P × (e^(r×t) - 1)
   * Using continuous compounding approximation
   */
  calculateRebaseValue(principal: number, yearsRemaining: number): number {
    return principal * (Math.exp(this.config.annualRebaseRate * yearsRemaining) - 1);
  }

  /**
   * Calculate incentive value: P × (incentiveAPY × t)
   * Only applies if lock has voted (eligible for gauge incentives)
   */
  calculateIncentiveValue(principal: number, yearsRemaining: number, voted: boolean): number {
    if (!voted) return 0;
    return principal * this.config.annualIncentiveRate * yearsRemaining;
  }

  /**
   * Check if lock is eligible for listing
   */
  checkEligibility(lock: LockData, now: number = Date.now() / 1000): { eligible: boolean; reasons: string[] } {
    const reasons: string[] = [];

    if (lock.escrowType !== 0) {
      reasons.push(`Escrow type is ${lock.escrowType} (must be NORMAL=0)`);
    }

    if (lock.grantManager !== "0x0000000000000000000000000000000000000000") {
      reasons.push("Grant lock (grantManager != 0) - not eligible");
    }

    if (!lock.isPermanent && lock.end <= now) {
      reasons.push("Lock expired");
    }

    if (!lock.isPermanent) {
      const remainingSeconds = lock.end - now;
      if (remainingSeconds < this.config.minRemainingTime) {
        reasons.push(`Remaining time ${remainingSeconds}s < minimum ${this.config.minRemainingTime}s`);
      }
    }

    return {
      eligible: reasons.length === 0,
      reasons
    };
  }

  /**
   * Main valuation function
   */
  evaluate(lock: LockData, listing: ListingData | null = null, now: number = Date.now() / 1000): ValuationResult {
    const mezoUsdPrice = this.getMezoUsdPrice();
    const yearsRemaining = this.calculateYearsRemaining(lock.end, lock.isPermanent, now);
    const discountFactor = this.calculateDiscountFactor(yearsRemaining);
    const discountedPrincipal = lock.amount * discountFactor;

    const rebaseValue = this.calculateRebaseValue(lock.amount, yearsRemaining);
    const incentiveValue = this.calculateIncentiveValue(lock.amount, yearsRemaining, lock.voted);

    const fairValueMezo = discountedPrincipal + rebaseValue + incentiveValue;
    const fairValueUsd = fairValueMezo * mezoUsdPrice;

    // Desk reference: desk pays deskDiscount4Year for 4-year lock
    // Scale by years remaining: deskReference = amount × deskDiscount4Year ^ (yearsRemaining / 4)
    const deskDiscountFactor = Math.pow(this.config.deskDiscount4Year, yearsRemaining / this.config.maxLockYears);
    const deskReferenceMezo = lock.amount * deskDiscountFactor;
    const deskReferenceUsd = deskReferenceMezo * mezoUsdPrice;

    // Listing comparison
    let listingPriceMezo: number | null = null;
    let listingPriceUsd: number | null = null;
    let premiumOverFair: number | null = null;
    let discountToDesk: number | null = null;

    if (listing && listingActive(listing, now) && listing.currentPrice !== undefined) {
      listingPriceMezo = listing.currentPrice / mezoUsdPrice; // MUSD ≈ USD, so MUSD/MEZO price
      listingPriceUsd = listing.currentPrice;

      if (fairValueMezo > 0) {
        premiumOverFair = (listingPriceMezo - fairValueMezo) / fairValueMezo;
      }

      if (deskReferenceMezo > 0) {
        discountToDesk = (deskReferenceMezo - listingPriceMezo) / deskReferenceMezo;
      }
    }

    const eligibility = this.checkEligibility(lock, now);

    return {
      tokenId: lock.tokenId,
      lockedAmount: lock.amount,
      yearsRemaining,
      discountFactor,
      discountedPrincipal,
      rebaseValue,
      incentiveValue,
      fairValueMezo,
      fairValueUsd,
      deskReferenceMezo,
      deskReferenceUsd,
      listingPriceMezo,
      listingPriceUsd,
      premiumOverFair,
      discountToDesk,
      isPermanent: lock.isPermanent,
      voted: lock.voted,
      eligible: eligibility.eligible,
      eligibilityReasons: eligibility.reasons,
      assumptions: this.config,
    };
  }

  /**
   * Evaluate multiple locks (for browse page)
   */
  evaluateAll(locks: LockData[], listings: Map<number, ListingData>, now: number = Date.now() / 1000): ValuationResult[] {
    return locks.map(lock => {
      const listing = listings.get(lock.tokenId) || null;
      return this.evaluate(lock, listing, now);
    });
  }
}

/**
 * Helper to check if listing is active
 */
function listingActive(listing: ListingData, now: number): boolean {
  return listing.seller !== "0x0000000000000000000000000000000000000000" &&
         !listing.cancelled &&
         !listing.sold &&
         now <= listing.endTime;
}

// ============ Default Export ============

export const defaultEngine = new ValuationEngine();

// ============ Utility Functions ============

/**
 * Format valuation for UI display
 */
export function formatValuation(result: ValuationResult): string {
  const lines = [
    `=== Lock #${result.tokenId} Valuation ===`,
    `Locked: ${result.lockedAmount.toLocaleString()} MEZO`,
    `Years remaining: ${result.yearsRemaining.toFixed(2)}`,
    `Discount factor: ${(result.discountFactor * 100).toFixed(1)}%`,
    `Discounted principal: ${result.discountedPrincipal.toLocaleString()} MEZO`,
    `Rebase value: ${result.rebaseValue.toLocaleString()} MEZO`,
    `Incentive value: ${result.incentiveValue.toLocaleString()} MEZO`,
    `---`,
    `Fair value: ${result.fairValueMezo.toLocaleString()} MEZO ($${result.fairValueUsd.toLocaleString()})`,
    `Desk reference: ${result.deskReferenceMezo.toLocaleString()} MEZO ($${result.deskReferenceUsd.toLocaleString()})`,
    result.listingPriceMezo !== null ? `Listing: ${result.listingPriceMezo.toLocaleString()} MEZO ($${result.listingPriceUsd!.toLocaleString()})` : "Not listed",
    result.premiumOverFair !== null ? `Premium over fair: ${(result.premiumOverFair * 100).toFixed(1)}%` : "",
    result.discountToDesk !== null ? `Discount to desk: ${(result.discountToDesk * 100).toFixed(1)}%` : "",
    `---`,
    `Eligible: ${result.eligible ? "Yes" : "No"}`,
    result.eligibilityReasons.length > 0 ? `Reasons: ${result.eligibilityReasons.join(", ")}` : "",
    `Assumptions: ${result.assumptions.annualDiscountRate * 100}% discount, ${result.assumptions.annualRebaseRate * 100}% rebase, ${result.assumptions.annualIncentiveRate * 100}% incentive`,
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Create engine with custom assumptions (for sensitivity analysis)
 */
export function createEngine(overrides: Partial<ValuationConfig>): ValuationEngine {
  return new ValuationEngine(overrides);
}