'use client'

import Link from 'next/link'
import { formatAddress, formatPrice, formatAmount, formatTime, formatDuration } from '@/lib/utils'

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

interface ListingCardProps { listing: ListingWithDetails }

export function ListingCard({ listing }: ListingCardProps) {
  const currentTime = BigInt(Math.floor(Date.now() / 1000))
  const timeRemaining = listing.endTime > currentTime ? listing.endTime - currentTime : 0n
  const isExpired = currentTime > listing.endTime
  const progress = listing.startTime < currentTime && listing.endTime > currentTime
    ? Number((currentTime - listing.startTime) * 100n / (listing.endTime - listing.startTime))
    : listing.endTime <= currentTime ? 100 : 0

  return (
    <Link href={`/lock/${listing.tokenId}`} className="group h-full flex flex-col rounded-2xl p-5 transition-all duration-200 hover:-translate-y-1" style={{ background: 'linear-gradient(145deg,#222831,#1b1f25)', border: '1px solid rgba(137,147,159,.18)', boxShadow: '0 10px 28px rgba(0,0,0,.14)' }}>
      <div className="flex items-center justify-between mb-5">
        <span className="text-xs font-mono tracking-wide" style={{ color: '#89939F' }}>POSITION / #{listing.tokenId.toString()}</span>
        <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold px-2.5 py-1 rounded-full" style={{ color: isExpired ? '#d58d83' : '#e0bd77', background: isExpired ? 'rgba(169,68,56,.14)' : 'rgba(214,168,79,.1)', border: '1px solid rgba(214,168,79,.18)' }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: isExpired ? '#c45a4c' : '#D6A84F' }} />
          {isExpired ? 'Expired' : 'Live listing'}
        </span>
      </div>

      <div className="mb-5">
        <p className="data-label mb-1">Current asking price</p>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tracking-tight text-white tabular-nums">{formatPrice(listing.currentPrice)}</span>
          <span className="text-sm font-medium" style={{ color: '#D6A84F' }}>MUSD</span>
        </div>
        <div className="mt-4 h-1.5 rounded-full overflow-hidden" style={{ background: '#111418' }}>
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, progress))}%`, background: 'linear-gradient(90deg,#8e382f,#c45a4c)' }} />
        </div>
        <div className="flex justify-between text-[11px] mt-2" style={{ color: '#89939F' }}>
          <span>Start {formatPrice(listing.startPrice)}</span>
          <span>End {formatPrice(listing.endPrice)}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-xl p-3 mb-4" style={{ background: 'rgba(12,15,19,.38)', border: '1px solid rgba(137,147,159,.1)' }}>
        <div>
          <p className="data-label mb-1">Locked amount</p>
          <p className="text-sm font-semibold text-white tabular-nums">{formatAmount(listing.lockAmount)} <span className="text-xs font-normal" style={{ color: '#89939F' }}>MEZO</span></p>
        </div>
        <div>
          <p className="data-label mb-1">Lock expiry</p>
          <p className="text-sm font-semibold text-white">{listing.isPermanent ? 'Permanent' : formatTime(listing.lockEnd).split(',')[0]}</p>
        </div>
        <div>
          <p className="data-label mb-1">Auction remaining</p>
          <p className="text-sm font-semibold" style={{ color: '#D6A84F' }}>{isExpired ? 'Expired' : formatDuration(timeRemaining)}</p>
        </div>
        <div>
          <p className="data-label mb-1">Seller</p>
          <p className="text-sm font-mono text-white">{formatAddress(listing.seller)}</p>
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between pt-3 border-t" style={{ borderColor: 'rgba(137,147,159,.14)' }}>
        <span className="text-xs" style={{ color: '#89939F' }}>Non-custodial listing</span>
        <span className="text-sm font-semibold transition-colors" style={{ color: '#d58d83' }}>Inspect position <span aria-hidden>→</span></span>
      </div>
    </Link>
  )
}
