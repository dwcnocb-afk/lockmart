'use client'

import { ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'

/* ------------------------------------------------------------------ */
/* useNow: re-renders on an interval so Dutch-auction prices stay live */
/* ------------------------------------------------------------------ */
export function useNow(intervalMs = 1000): bigint {
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)))
  useEffect(() => {
    const id = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/* ------------------------------------------------------------------ */
/* Tooltip / Term: plain-language help for DeFi vocabulary             */
/* ------------------------------------------------------------------ */
export function Term({ children, tip }: { children: ReactNode; tip: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span className="relative inline-block">
      <span
        tabIndex={0}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={e => e.key === 'Escape' && setOpen(false)}
        className="cursor-help"
        style={{ borderBottom: '1px dotted rgba(214,168,79,.7)' }}
      >
        {children}
      </span>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute left-1/2 bottom-full z-50 mb-2 w-60 -translate-x-1/2 rounded-lg px-3 py-2 text-xs font-normal leading-5 normal-case tracking-normal transition-all duration-150"
        style={{
          opacity: open ? 1 : 0,
          transform: `translate(-50%, ${open ? '0' : '4px'})`,
          visibility: open ? 'visible' : 'hidden',
          background: '#0e1013',
          color: '#d8dde3',
          border: '1px solid rgba(137,147,159,.28)',
          boxShadow: '0 12px 30px rgba(0,0,0,.5)',
          textAlign: 'left',
        }}
      >
        {tip}
      </span>
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* CountUp: eases a number into place (respects reduced motion)        */
/* ------------------------------------------------------------------ */
export function CountUp({
  value,
  decimals = 0,
  duration = 900,
  suffix = '',
}: {
  value: number
  decimals?: number
  duration?: number
  suffix?: string
}) {
  const [display, setDisplay] = useState(value)
  const fromRef = useRef(value)

  useEffect(() => {
    const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || !Number.isFinite(value)) {
      setDisplay(value)
      fromRef.current = value
      return
    }
    const from = fromRef.current
    const start = performance.now()
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      setDisplay(from + (value - from) * eased)
      if (p < 1) raf = requestAnimationFrame(tick)
      else fromRef.current = value
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])

  return (
    <span className="tabular">
      {display.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Spotlight: pointer-tracked highlight, adapted for Lockmart's palette */
/* ------------------------------------------------------------------ */
export function useSpotlight<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const onMouseMove = useCallback((e: React.MouseEvent<T>) => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    el.style.setProperty('--mx', `${e.clientX - r.left}px`)
    el.style.setProperty('--my', `${e.clientY - r.top}px`)
  }, [])
  return { ref, onMouseMove }
}

/* ------------------------------------------------------------------ */
/* StatusPill                                                          */
/* ------------------------------------------------------------------ */
export type ListingStatus = 'live' | 'ending' | 'expired' | 'sold' | 'cancelled'

const STATUS_STYLE: Record<ListingStatus, { label: string; color: string; bg: string; border: string; pulse: boolean }> = {
  live: { label: 'Live', color: '#e0bd77', bg: 'rgba(214,168,79,.10)', border: 'rgba(214,168,79,.28)', pulse: true },
  ending: { label: 'Ending soon', color: '#e5a79d', bg: 'rgba(169,68,56,.16)', border: 'rgba(196,90,76,.4)', pulse: true },
  expired: { label: 'Expired', color: '#89939f', bg: 'rgba(137,147,159,.10)', border: 'rgba(137,147,159,.25)', pulse: false },
  sold: { label: 'Sold', color: '#aeb6c0', bg: 'rgba(137,147,159,.10)', border: 'rgba(137,147,159,.25)', pulse: false },
  cancelled: { label: 'Withdrawn', color: '#89939f', bg: 'rgba(137,147,159,.08)', border: 'rgba(137,147,159,.2)', pulse: false },
}

export function StatusPill({ status }: { status: ListingStatus }) {
  const s = STATUS_STYLE[status]
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]"
      style={{ color: s.color, background: s.bg, border: `1px solid ${s.border}` }}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${s.pulse ? 'animate-pulse-dot' : ''}`}
        style={{ background: s.color }}
      />
      {s.label}
    </span>
  )
}

export function getStatus(opts: {
  now: bigint
  endTime: bigint
  cancelled?: boolean
  sold?: boolean
}): ListingStatus {
  if (opts.sold) return 'sold'
  if (opts.cancelled) return 'cancelled'
  if (opts.now > opts.endTime) return 'expired'
  if (opts.endTime - opts.now < 3600n) return 'ending'
  return 'live'
}

/* ------------------------------------------------------------------ */
/* PriceCurve: the Dutch-auction path, with a marker for "now"         */
/* ------------------------------------------------------------------ */
export function PriceCurve({
  startPrice,
  endPrice,
  startTime,
  endTime,
  now,
  height = 56,
  muted = false,
}: {
  startPrice: bigint
  endPrice: bigint
  startTime: bigint
  endTime: bigint
  now: bigint
  height?: number
  muted?: boolean
}) {
  const W = 240
  const pad = 6
  const span = endTime > startTime ? endTime - startTime : 1n
  const p = now <= startTime ? 0 : now >= endTime ? 1 : Number(((now - startTime) * 10000n) / span) / 10000
  const hi = Number(startPrice)
  const lo = Number(endPrice)
  const range = hi - lo
  const y = (price: number) => (range <= 0 ? height / 2 : pad + ((hi - price) / range) * (height - pad * 2))
  const x0 = pad
  const x1 = W - pad
  const cx = x0 + p * (x1 - x0)
  const cy = range <= 0 ? height / 2 : pad + p * (height - pad * 2)
  const stroke = muted ? '#5d6773' : '#c45a4c'
  const gid = useId().replace(/:/g, '')

  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} role="img" aria-label="Price decay from opening price to floor price" preserveAspectRatio="none">
      <defs>
        <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`M${x0},${y(hi)} L${x1},${y(lo)} L${x1},${height} L${x0},${height} Z`} fill={`url(#g${gid})`} />
      <line x1={x0} y1={y(hi)} x2={x1} y2={y(lo)} stroke="rgba(137,147,159,.35)" strokeWidth="1" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
      <line x1={x0} y1={y(hi)} x2={cx} y2={cy} stroke={stroke} strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {!muted && p < 1 && (
        <>
          <circle cx={cx} cy={cy} r="7" fill="#c45a4c" opacity="0.22" />
          <circle cx={cx} cy={cy} r="3.2" fill="#f2f0ec" stroke="#c45a4c" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* CopyButton                                                          */
/* ------------------------------------------------------------------ */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        } catch {
          /* clipboard unavailable, fail silently */
        }
      }}
      className="rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
      style={{ color: copied ? '#e0bd77' : '#89939f', border: '1px solid rgba(137,147,159,.2)' }}
    >
      {copied ? 'Copied' : label}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Brand mark                                                          */
/* ------------------------------------------------------------------ */
export function LockmartMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden>
      <rect x="1" y="1" width="38" height="38" rx="10" fill="#1d2127" stroke="rgba(214,168,79,.45)" />
      <path d="M13 11v17h14" fill="none" stroke="#c45a4c" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="19" y="14" width="9" height="8" rx="1.6" fill="#d6a84f" />
      <path d="M21 14v-2.2a2.5 2.5 0 0 1 5 0V14" fill="none" stroke="#d6a84f" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
