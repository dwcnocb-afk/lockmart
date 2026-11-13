export function formatAddress(address: string, chars = 4): string {
  if (!address) return ''
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`
}

export function formatBigInt(value: bigint, decimals = 18, fixed = 4): string {
  const divisor = 10n ** BigInt(decimals)
  const whole = value / divisor
  const fraction = value % divisor
  if (fraction === 0n) return whole.toString()
  const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, fixed)
  return `${whole}.${fractionStr}`
}

export function formatPrice(value: bigint): string {
  return formatBigInt(value, 18, 4)
}

export function formatAmount(value: bigint): string {
  return formatBigInt(value, 18, 2)
}

export function formatTime(timestamp: bigint): string {
  const date = new Date(Number(timestamp) * 1000)
  return date.toLocaleString()
}

export function formatDuration(seconds: bigint): string {
  const secs = Number(seconds)
  const days = Math.floor(secs / 86400)
  const hours = Math.floor((secs % 86400) / 3600)
  const minutes = Math.floor((secs % 3600) / 60)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function calculateCurrentPrice(
  startPrice: bigint,
  endPrice: bigint,
  startTime: bigint,
  endTime: bigint,
  currentTime: bigint
): bigint {
  if (currentTime >= endTime) return endPrice
  if (currentTime <= startTime) return startPrice
  if (startPrice === endPrice) return startPrice

  const elapsed = currentTime - startTime
  const duration = endTime - startTime
  const priceDiff = startPrice - endPrice

  // Linear interpolation: price = startPrice - (priceDiff * elapsed / duration)
  return startPrice - (priceDiff * elapsed / duration)
}

export const ERROR_MESSAGES: Record<string, string> = {
  AlreadyListed: 'This lock is already listed for sale.',
  EscrowTypeNotNormal: 'Only NORMAL escrow type locks can be listed.',
  FeeTooHigh: 'Fee is too high.',
  GrantLockNotAllowed: 'Grant locks cannot be listed.',
  InvalidDuration: 'Invalid listing duration.',
  InvalidPrice: 'Invalid price. End price must be less than or equal to start price.',
  ListingCancelled: 'This listing has been cancelled.',
  ListingExpired: 'This listing has expired.',
  ListingSold: 'This listing has already been sold.',
  LockAmountBelowMin: 'Lock amount is below minimum.',
  LockEndBelowMin: 'Lock end time is below minimum.',
  LockExpired: 'This lock has expired.',
  NotListed: 'This lock is not listed for sale.',
  NotOwnerOrApproved: 'You are not the owner or approved operator.',
  NotSeller: 'You are not the seller of this listing.',
  PermitFailed: 'Permit signature verification failed.',
  PriceExceedsMax: 'Price exceeds maximum allowed.',
  ReentrancyGuardReentrantCall: 'Reentrant call detected.',
  TransferFailed: 'Token transfer failed.',
  ZeroAddress: 'Zero address not allowed.',
  ZeroFeeRecipient: 'Zero fee recipient not allowed.',
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Check for custom errors in the message
    for (const [key, message] of Object.entries(ERROR_MESSAGES)) {
      if (error.message.includes(key)) {
        return message
      }
    }
    return error.message
  }
  if (typeof error === 'string') {
    for (const [key, message] of Object.entries(ERROR_MESSAGES)) {
      if (error.includes(key)) {
        return message
      }
    }
    return error
  }
  return 'An unknown error occurred'
}