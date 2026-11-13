'use client'

import Link from 'next/link'
import { formatAddress, formatPrice, formatAmount, formatTime, formatDuration, calculateCurrentPrice } from '@/lib/utils'

interface ListingWithDetails {
  tokenId: bigint
  seller: string
  startPrice: bigint
  endPrice: bigint
  startTime: bigint
  endTime: bigint
  cancelled: boolean
  sold: boolean
  currentPrice: bigint
  lockAmount: bigint
  lockEnd: bigint
  isPermanent: boolean
}

interface ListingCardProps {
  listing: ListingWithDetails
}

export function ListingCard({ listing }: ListingCardProps) {
  const currentTime = BigInt(Math.floor(Date.now() / 1000))
  const timeRemaining = listing.endTime > currentTime ? listing.endTime - currentTime : 0n
  const isExpired = currentTime > listing.endTime
  const progress = listing.startTime < currentTime && listing.endTime > currentTime
    ? Number((currentTime - listing.startTime) * 100n / (listing.endTime - listing.startTime))
    : listing.endTime <= currentTime ? 100 : 0

  return (
    <Link
      href={`/lock/${listing.tokenId}`}
      className="card hover:shadow-lg transition-shadow h-full flex flex-col"
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <span className="text-sm font-mono text-gray-500 dark:text-gray-400">
            #{listing.tokenId.toString()}
          </span>
        </div>
        <span className={`px-2 py-1 text-xs font-medium rounded-full ${
          isExpired ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' :
          listing.cancelled ? 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300' :
          'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
        }`}>
          {isExpired ? 'Expired' : listing.cancelled ? 'Cancelled' : 'Active'}
        </span>
      </div>

      {/* Current Price */}
      <div className="mb-4">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-2xl font-bold text-gray-900 dark:text-white">
            {formatPrice(listing.currentPrice)} MUSD
          </span>
        </div>
        {/* Price progression bar */}
        <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-primary-600 transition-all duration-300"
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
          <span>Start: {formatPrice(listing.startPrice)}</span>
          <span>End: {formatPrice(listing.endPrice)}</span>
        </div>
      </div>

      {/* Lock Info */}
      <div className="space-y-2 mb-4 border-t border-gray-200 dark:border-gray-700 pt-4 flex-1">
        <div className="flex justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">Lock Amount</span>
          <span className="font-medium text-gray-900 dark:text-white">
            {formatAmount(listing.lockAmount)} MEZO
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">Lock End</span>
          <span className="font-medium text-gray-900 dark:text-white">
            {listing.isPermanent ? 'Permanent' : formatTime(listing.lockEnd)}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">Time Left</span>
          <span className="font-medium text-gray-900 dark:text-white">
            {isExpired ? 'Expired' : formatDuration(timeRemaining)}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">Seller</span>
          <span className="font-medium text-gray-900 dark:text-white font-mono">
            {formatAddress(listing.seller)}
          </span>
        </div>
      </div>

      <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
        <span className="w-full btn-primary text-center block">
          View Details
        </span>
      </div>
    </Link>
  )
}