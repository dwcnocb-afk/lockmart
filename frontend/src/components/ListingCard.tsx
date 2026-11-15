'use client'

import Link from 'next/link'
import { formatAddress, formatPrice, formatAmount, formatTime, formatDuration, calculateCurrentPrice } from '@/lib/utils'
import { PriceCurve, StatusPill, Term, getStatus, useNow, useSpotlight } from '@/components/ui'

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

interface ListingCardProps { listing: ListingWithDetails; index?: number }

export function ListingCard({ listing, index = 0 }: ListingCardProps) {
  const now = useNow(15000)
  const { ref, onMouseMove } = useSpotlight<HTMLAnchorElement>()

  const status = getStatus({ now, endTime: listing.endTime, cancelled: listing.cancelled, sold: listing.sold })
  const unavailable = status === 'expired' || status === 'sold' || status === 'cancelled'
  const timeRemaining = listing.endTime > now ? listing.endTime - now : 0n

  // Live price from the same linear schedule the contract uses.
  const livePrice = calculateCurrentPrice(listing.startPrice, listing.endPrice, listing.startTime, listing.endTime, now)
  const price = unavailable ? listing.currentPrice : livePrice

  // Discount against the opening ask, in basis points (real data, not an estimate).
  const discountBps = listing.startPrice > 0n && listing.startPrice > price
    ? Number(((listing.startPrice - price) * 10000n) / listing.startPrice)
    : 0
  const discountLabel = (discountBps / 100).toFixed(discountBps >= 1000 ? 0 : 1)

  const [whole, frac = ''] = formatPrice(price).split('.')
  const perMezo =
    listing.lockAmount > 0n ? Number((price * 10000n) / listing.lockAmount) / 10000 : null

  return (
    <Link
      ref={ref}
      onMouseMove={onMouseMove}
      href={`/lock/${listing.tokenId}`}
      aria-label={`Lock number ${listing.tokenId.toString()}, asking ${formatPrice(price)} MUSD`}
      className="spotlight reveal group flex h-full flex-col rounded-2xl p-5 transition-all duration-300 hover:-translate-y-1"
      style={{
        animationDelay: `${Math.min(index, 8) * 60}ms`,
        background: 'linear-gradient(160deg,rgba(34,40,49,.92),rgba(24,28,34,.98))',
        border: '1px solid rgba(137,147,159,.16)',
        boxShadow: '0 1px 0 rgba(255,255,255,.03) inset, 0 16px 32px -20px rgba(0,0,0,.7)',
        opacity: unavailable ? 0.62 : undefined,
        filter: unavailable ? 'saturate(.5)' : undefined,
      }}
    >
      <div className="mb-5 flex items-center justify-between">
        <span className="font-mono text-xs tracking-wide" style={{ color: '#89939F' }}>
          Lock <span style={{ color: '#d8dde3' }}>#{listing.tokenId.toString()}</span>
        </span>
        <StatusPill status={status} />
      </div>

      <div>
        <p className="data-label mb-1.5">
          <Term tip="The price falls in a straight line from the seller's opening ask to a floor price. Buy whenever it looks right to you.">Dutch auction</Term> ask
        </p>
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-baseline gap-1.5">
            <span className="font-display text-[40px] font-medium leading-none tracking-tight text-white tabular">
              {whole}
              {frac && <span className="text-[22px]" style={{ color: '#aeb6c0' }}>.{frac}</span>}
            </span>
            <span className="text-sm font-medium" style={{ color: '#D6A84F' }}>MUSD</span>
          </div>
          {discountBps > 0 && !unavailable && (
            <span
              className="mb-1 rounded-md px-2 py-1 text-[11px] font-semibold tabular"
              style={{ color: '#e0bd77', background: 'rgba(214,168,79,.1)', border: '1px solid rgba(214,168,79,.22)' }}
              title="Current price compared with the opening ask"
            >
              −{discountLabel}% from open
            </span>
          )}
        </div>

        <div className="mt-3">
          <PriceCurve
            startPrice={listing.startPrice}
            endPrice={listing.endPrice}
            startTime={listing.startTime}
            endTime={listing.endTime}
            now={now}
            muted={unavailable}
          />
          <div className="mt-1 flex justify-between text-[11px] tabular" style={{ color: '#89939F' }}>
            <span>Opened {formatPrice(listing.startPrice)}</span>
            <span>Floor {formatPrice(listing.endPrice)}</span>
          </div>
        </div>
      </div>

      <dl className="mt-5 space-y-2.5">
        <div className="ledger-row"><dt>Locked</dt><dd>{formatAmount(listing.lockAmount)} MEZO</dd></div>
        <div className="ledger-row">
          <dt>Unlocks</dt>
          <dd>{listing.isPermanent ? 'Permanent' : formatTime(listing.lockEnd).split(',')[0]}</dd>
        </div>
        {perMezo !== null && (
          <div className="ledger-row">
            <dt><Term tip="Current MUSD price divided by the MEZO locked. A quick way to compare listings of different sizes.">Cost per MEZO</Term></dt>
            <dd>{perMezo.toFixed(4)} MUSD</dd>
          </div>
        )}
        <div className="ledger-row">
          <dt>Auction ends in</dt>
          <dd style={{ color: status === 'ending' ? '#e5a79d' : undefined }}>
            {unavailable ? '—' : formatDuration(timeRemaining)}
          </dd>
        </div>
        <div className="ledger-row"><dt>Seller</dt><dd className="font-mono text-[13px]">{formatAddress(listing.seller)}</dd></div>
      </dl>

      <div className="mt-auto pt-5">
        <div
          className="flex items-center justify-between rounded-xl px-4 py-3 text-sm font-semibold transition-colors duration-300"
          style={{
            color: unavailable ? '#89939F' : '#fff',
            background: unavailable ? 'rgba(137,147,159,.08)' : 'rgba(169,68,56,.22)',
            border: `1px solid ${unavailable ? 'rgba(137,147,159,.16)' : 'rgba(196,90,76,.4)'}`,
          }}
        >
          <span>{unavailable ? 'View details' : 'Review & buy'}</span>
          <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">→</span>
        </div>
      </div>
    </Link>
  )
}
