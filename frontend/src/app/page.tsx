'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { createPublicClient, http, parseAbiItem, Abi, Log, Chain } from 'viem'
import { MEZO_TESTNET_ID, MEZO_TESTNET_RPC, MEZO_TESTNET_NAME, MEZO_TESTNET_EXPLORER } from '@/lib/wagmi'
import { Nav } from '@/components/Nav'
import { ListingCard } from '@/components/ListingCard'
import { CountUp, Term } from '@/components/ui'
import { DEPLOY_BLOCK, LOCKMARKET_ABI, veMEZO_ABI, getAddresses } from '@/lib/contracts'
import { getErrorMessage, formatAddress } from '@/lib/utils'

const RPC_URL = MEZO_TESTNET_RPC
const CHUNK_SIZE = 5000n // Process logs in chunks of 5000 blocks

// Fetch event logs in ranges smaller than the Mezo RPC provider's 10,000-block limit.
async function getLogsInChunks<T>(
  fetchChunk: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  startBlock: bigint,
  endBlock: bigint
): Promise<T[]> {
  const chunkSize = 5000n
  const allLogs: T[] = []
  let fromBlock = startBlock

  while (fromBlock <= endBlock) {
    const toBlock =
      fromBlock + chunkSize > endBlock
        ? endBlock
        : fromBlock + chunkSize

    const logs = await fetchChunk(fromBlock, toBlock)
    allLogs.push(...logs)
    fromBlock = toBlock + 1n
  }

  return allLogs
}

// Create a minimal chain object for the public client (module level, not passed to client components)
const mezoTestnetChain: Chain = {
  id: MEZO_TESTNET_ID,
  name: MEZO_TESTNET_NAME,
  nativeCurrency: { decimals: 18, name: 'BTC', symbol: 'BTC' },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Mezo Explorer', url: MEZO_TESTNET_EXPLORER } },
  testnet: true,
}

// Event ABIs for typed logs
const LISTED_EVENT = parseAbiItem('event Listed(uint256 indexed tokenId, address indexed seller, uint256 startPrice, uint256 endPrice, uint256 duration)')
const CANCELLED_EVENT = parseAbiItem('event Cancelled(uint256 indexed tokenId, address indexed seller)')
const SOLD_EVENT = parseAbiItem('event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 fee)')

// Create a public client for reading events
const publicClient = createPublicClient({
  chain: mezoTestnetChain,
  transport: http(RPC_URL),
})

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

// Type for logs with decoded args
interface ListedLogArgs {
  tokenId: bigint
  seller: `0x${string}`
  startPrice: bigint
  endPrice: bigint
  duration: bigint
}

interface CancelledLogArgs {
  tokenId: bigint
  seller: `0x${string}`
}

interface SoldLogArgs {
  tokenId: bigint
  seller: `0x${string}`
  buyer: `0x${string}`
  price: bigint
  fee: bigint
}

interface TypedLog<T> extends Log {
  args: T
}

type ListedLog = TypedLog<ListedLogArgs>
type CancelledLog = TypedLog<CancelledLogArgs>
type SoldLog = TypedLog<SoldLogArgs>

export default function BrowsePage() {
  const [listings, setListings] = useState<ListingWithDetails[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastScannedBlock, setLastScannedBlock] = useState<bigint>(DEPLOY_BLOCK)

  const fetchListings = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const addresses = getAddresses(MEZO_TESTNET_ID)
      const lockMarketAddress = addresses.LockMarket as `0x${string}`

      // Get current block number
      const currentBlock = await publicClient.getBlockNumber()

      // Fetch Listed, Cancelled, and Sold events in chunks to respect the Mezo RPC limit.
      const allLogs = await getLogsInChunks(
        (fromBlock, toBlock) =>
          publicClient.getLogs({
            address: lockMarketAddress,
            event: LISTED_EVENT,
            fromBlock,
            toBlock,
          }),
        DEPLOY_BLOCK,
        currentBlock
      ) as ListedLog[]

      const cancelledLogs = await getLogsInChunks(
        (fromBlock, toBlock) =>
          publicClient.getLogs({
            address: lockMarketAddress,
            event: CANCELLED_EVENT,
            fromBlock,
            toBlock,
          }),
        DEPLOY_BLOCK,
        currentBlock
      ) as CancelledLog[]

      const soldLogs = await getLogsInChunks(
        (fromBlock, toBlock) =>
          publicClient.getLogs({
            address: lockMarketAddress,
            event: SOLD_EVENT,
            fromBlock,
            toBlock,
          }),
        DEPLOY_BLOCK,
        currentBlock
      ) as SoldLog[]

      // Keep the latest lifecycle event for each token. A cancellation or sale
      // only invalidates a listing if it happened AFTER that listing; older
      // terminal events must not hide a subsequently relisted NFT.
      const tokenIdMap = new Map<bigint, ListedLog>()
      for (const log of allLogs) {
        const tokenId = log.args.tokenId
        const existing = tokenIdMap.get(tokenId)
        if (
          !existing ||
          (log.blockNumber ?? 0n) > (existing.blockNumber ?? 0n) ||
          ((log.blockNumber ?? 0n) === (existing.blockNumber ?? 0n) &&
            (log.logIndex ?? 0) > (existing.logIndex ?? 0))
        ) {
          tokenIdMap.set(tokenId, log)
        }
      }

      const terminalEvents = new Map<bigint, { blockNumber: bigint; logIndex: number }>()
      for (const log of [...cancelledLogs, ...soldLogs]) {
        const tokenId = log.args.tokenId
        const position = {
          blockNumber: log.blockNumber ?? 0n,
          logIndex: log.logIndex ?? 0,
        }
        const previous = terminalEvents.get(tokenId)
        if (
          !previous ||
          position.blockNumber > previous.blockNumber ||
          (position.blockNumber === previous.blockNumber && position.logIndex > previous.logIndex)
        ) {
          terminalEvents.set(tokenId, position)
        }
      }

      // Fetch details for each unique tokenId
      const listingDetails: ListingWithDetails[] = []

      for (const [tokenId, log] of tokenIdMap) {
        // Ignore a token only when its most recent cancel/sale happened
        // after the latest Listed event.
        const terminalEvent = terminalEvents.get(tokenId)
        if (terminalEvent) {
          const listingBlock = log.blockNumber ?? 0n
          if (
            terminalEvent.blockNumber > listingBlock ||
            (terminalEvent.blockNumber === listingBlock &&
              terminalEvent.logIndex > (log.logIndex ?? 0))
          ) {
            continue
          }
        }

        try {
          // Get listing details
          const listing = await publicClient.readContract({
            address: lockMarketAddress,
            abi: LOCKMARKET_ABI,
            functionName: 'getListing',
            args: [tokenId],
          }) as [bigint, string, bigint, bigint, bigint, bigint, boolean, boolean]

          const [, seller, startPrice, endPrice, startTime, endTime, cancelled, sold] = listing

          // Skip if cancelled or sold (double check)
          if (cancelled || sold) continue

          // Check if expired
          const currentTime = BigInt(Math.floor(Date.now() / 1000))
          if (currentTime > endTime) continue

          // The listing getter is the source of truth for listing status.
          // Do not discard a valid Listed event solely because the optional
          // inspect() helper reports listingActive=false or is unavailable.
          let amount = 0n
          let end = 0n
          let isPermanent = false
          let currentPrice = startPrice

          try {
            const lockData = await publicClient.readContract({
              address: lockMarketAddress,
              abi: LOCKMARKET_ABI,
              functionName: 'inspect',
              args: [tokenId],
            }) as [bigint, bigint, boolean, bigint, boolean, number, string, bigint, boolean]

            amount = lockData[0]
            end = lockData[1]
            isPermanent = lockData[2]
            currentPrice = lockData[7]
          } catch (inspectError) {
            // Fallback to the veMEZO NFT's canonical lock getter.
            const veMezoAddress = addresses.veMEZO as `0x${string}`
            const lock = await publicClient.readContract({
              address: veMezoAddress,
              abi: veMEZO_ABI,
              functionName: 'locked',
              args: [tokenId],
            }) as [bigint, bigint, boolean]
            amount = BigInt(lock[0])
            end = lock[1]
            isPermanent = lock[2]
            console.warn(`inspect() failed for tokenId ${tokenId}; used veMEZO.locked():`, inspectError)
          }

          listingDetails.push({
            tokenId,
            seller,
            startPrice,
            endPrice,
            startTime,
            endTime,
            cancelled,
            sold,
            currentPrice,
            lockAmount: amount,
            lockEnd: end,
            isPermanent,
          })
        } catch (detailError) {
          console.warn(`Failed to fetch details for tokenId ${tokenId}:`, detailError)
        }
      }

      // Sort by tokenId (newest first)
      listingDetails.sort((a, b) => Number(b.tokenId - a.tokenId))

      setListings(listingDetails)
      setLastScannedBlock(currentBlock)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchListings()
  }, [fetchListings])

  type SortKey = 'newest' | 'price-asc' | 'price-desc' | 'ending' | 'size'
  const [sortKey, setSortKey] = useState<SortKey>('newest')

  const sortedListings = useMemo(() => {
    const copy = [...listings]
    switch (sortKey) {
      case 'price-asc': return copy.sort((a, b) => (a.currentPrice < b.currentPrice ? -1 : a.currentPrice > b.currentPrice ? 1 : 0))
      case 'price-desc': return copy.sort((a, b) => (a.currentPrice > b.currentPrice ? -1 : a.currentPrice < b.currentPrice ? 1 : 0))
      case 'ending': return copy.sort((a, b) => (a.endTime < b.endTime ? -1 : a.endTime > b.endTime ? 1 : 0))
      case 'size': return copy.sort((a, b) => (a.lockAmount > b.lockAmount ? -1 : a.lockAmount < b.lockAmount ? 1 : 0))
      default: return copy
    }
  }, [listings, sortKey])

  // Headline stats come straight from the scanned on-chain listings.
  const stats = useMemo(() => {
    const totalLocked = listings.reduce((sum, l) => sum + l.lockAmount, 0n)
    const lowest = listings.length ? listings.reduce((m, l) => (l.currentPrice < m ? l.currentPrice : m), listings[0].currentPrice) : null
    return {
      count: listings.length,
      totalLocked: Number(totalLocked / 10n ** 14n) / 10000, // MEZO, 4dp precision
      lowest: lowest === null ? null : Number(lowest / 10n ** 14n) / 10000,
    }
  }, [listings])

  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'newest', label: 'Newest' },
    { key: 'price-asc', label: 'Lowest price' },
    { key: 'price-desc', label: 'Highest price' },
    { key: 'ending', label: 'Ending soon' },
    { key: 'size', label: 'Largest lock' },
  ]

  return (
    <div className="min-h-screen">
      <Nav />
      <main id="main" className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-8">
        {/* ---------- Hero ---------- */}
        <section className="relative mt-8 mb-12 sm:mt-12">
          <div className="grid items-end gap-10 lg:grid-cols-[1.35fr_1fr]">
            <div className="reveal">
              <div className="eyebrow mb-6 flex items-center gap-3">
                <span className="h-px w-8" style={{ background: '#D6A84F' }} />
                Secondary market · Mezo Testnet
              </div>
              <h1 className="font-display text-[44px] font-medium leading-[1.04] tracking-[-0.02em] text-white sm:text-6xl lg:text-[68px] text-balance">
                Locked for years.<br />
                <span style={{ color: '#d58d83' }}>Sold on your schedule.</span>
              </h1>
              <p className="mt-6 max-w-xl text-base leading-7 sm:text-[17px]" style={{ color: '#aeb6c0' }}>
                Lockmart is a non-custodial marketplace for{' '}
                <Term tip="A voting-escrow NFT. MEZO is locked for a set time, and the lock itself is a transferable token that carries voting power.">veMEZO</Term>{' '}
                locks. Sellers set a falling-price auction, buyers settle in MUSD, and every trade can be checked on Mezo Explorer.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <a href="#marketplace" className="btn-primary !px-6 !py-3">Browse listings <span aria-hidden>→</span></a>
                <Link href="/sell" className="btn-secondary !px-6 !py-3">List a veMEZO lock</Link>
              </div>
            </div>

            {/* Live market readout */}
            <div className="reveal rounded-2xl p-6" style={{ animationDelay: '120ms', background: 'linear-gradient(160deg,rgba(34,40,49,.85),rgba(21,24,29,.95))', border: '1px solid rgba(137,147,159,.18)' }}>
              <div className="mb-5 flex items-center justify-between">
                <p className="eyebrow">Market readout</p>
                <span className="flex items-center gap-2 text-[11px]" style={{ color: '#89939F' }}>
                  <span className={`h-1.5 w-1.5 rounded-full ${loading ? 'animate-pulse-dot' : ''}`} style={{ background: loading ? '#89939F' : '#D6A84F' }} />
                  {loading ? 'Scanning chain' : error ? 'Scan failed' : `Block ${lastScannedBlock.toString()}`}
                </span>
              </div>
              <div className="space-y-5">
                <div>
                  <p className="data-label mb-1">Active listings</p>
                  <p className="font-display text-5xl font-medium leading-none text-white">
                    {loading ? <span className="skeleton inline-block h-10 w-16 align-middle" /> : error ? '—' : <CountUp value={stats.count} />}
                  </p>
                </div>
                <div className="hairline" />
                <div className="grid grid-cols-2 gap-5">
                  <div>
                    <p className="data-label mb-1">MEZO on offer</p>
                    <p className="font-display text-2xl font-medium text-white">
                      {loading ? <span className="skeleton inline-block h-6 w-20 align-middle" /> : error ? '—' : <CountUp value={stats.totalLocked} decimals={2} />}
                    </p>
                  </div>
                  <div>
                    <p className="data-label mb-1">Lowest ask</p>
                    <p className="font-display text-2xl font-medium" style={{ color: '#D6A84F' }}>
                      {loading ? <span className="skeleton inline-block h-6 w-20 align-middle" /> : stats.lowest === null ? '—' : <><CountUp value={stats.lowest} decimals={2} /> <span className="text-sm">MUSD</span></>}
                    </p>
                  </div>
                </div>
                <div className="hairline" />
                <p className="text-xs leading-5" style={{ color: '#89939F' }}>
                  Settles in <Term tip="Mezo's Bitcoin-backed stablecoin. Every Lockmart price is quoted and paid in MUSD.">MUSD</Term>.
                  Figures are read live from the LockMarket contract.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ---------- Marketplace ---------- */}
        <section id="marketplace" className="scroll-mt-24">
          <div className="mb-6 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
            <div>
              <p className="eyebrow mb-2">The marketplace</p>
              <h2 className="font-display text-3xl font-medium tracking-tight text-white sm:text-4xl">Open positions</h2>
              <p className="mt-2 max-w-lg text-sm leading-6" style={{ color: '#89939F' }}>
                Every card is a veMEZO lock listed by its holder. Prices drift down until someone buys or the auction closes.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div role="group" aria-label="Sort listings" className="flex flex-wrap gap-1 rounded-xl p-1" style={{ background: 'rgba(27,31,37,.8)', border: '1px solid rgba(137,147,159,.16)' }}>
                {sortOptions.map(o => (
                  <button
                    key={o.key}
                    onClick={() => setSortKey(o.key)}
                    aria-pressed={sortKey === o.key}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors duration-200"
                    style={{
                      color: sortKey === o.key ? '#fff' : '#89939F',
                      background: sortKey === o.key ? 'rgba(169,68,56,.28)' : 'transparent',
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <button onClick={fetchListings} className="btn-secondary !py-2" disabled={loading} aria-label="Refresh listings">
                <span aria-hidden className={loading ? 'inline-block animate-spin' : ''}>↻</span> {loading ? 'Scanning…' : 'Refresh'}
              </button>
            </div>
          </div>

          {error && (
            <div role="alert" className="mb-6 rounded-xl border p-4 text-sm" style={{ background: 'rgba(169,68,56,.12)', borderColor: 'rgba(196,90,76,.3)', color: '#e5b7b0' }}>
              <span className="font-semibold">We couldn&apos;t read the listings.</span> {error}
              <button onClick={fetchListings} className="ml-3 underline underline-offset-4">Try again</button>
            </div>
          )}

          {loading ? (
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading listings">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="rounded-2xl p-5" style={{ background: 'rgba(27,31,37,.7)', border: '1px solid rgba(137,147,159,.14)' }}>
                  <div className="skeleton mb-6 h-3 w-1/3" />
                  <div className="skeleton mb-4 h-10 w-2/3" />
                  <div className="skeleton mb-6 h-14" />
                  <div className="space-y-3">
                    {[...Array(4)].map((__, j) => <div key={j} className="skeleton h-3" />)}
                  </div>
                  <div className="skeleton mt-6 h-11" />
                </div>
              ))}
            </div>
          ) : error ? null : listings.length === 0 ? (
            <div className="rounded-2xl p-10 text-center sm:p-16" style={{ background: 'rgba(27,31,37,.55)', border: '1px dashed rgba(137,147,159,.3)' }}>
              <svg className="mx-auto mb-6" width="56" height="56" viewBox="0 0 56 56" aria-hidden>
                <rect x="6" y="6" width="44" height="44" rx="12" fill="none" stroke="rgba(214,168,79,.4)" strokeDasharray="3 5" />
                <path d="M20 18v20h16" fill="none" stroke="#c45a4c" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p className="font-display text-2xl font-medium text-white">Nothing is for sale right now</p>
              <p className="mx-auto mt-3 max-w-md text-sm leading-6" style={{ color: '#89939F' }}>
                Listings appear here the moment a holder puts a veMEZO lock on the market. If you hold one, you can be the first: pick a start price, a floor, and a duration.
              </p>
              <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
                <Link href="/sell" className="btn-primary">List a lock</Link>
                <button onClick={fetchListings} className="btn-secondary">Check again</button>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between text-xs" style={{ color: '#89939F' }}>
                <span>{listings.length} open position{listings.length !== 1 ? 's' : ''}</span>
                <span className="font-mono">Scanned to block {lastScannedBlock.toString()}</span>
              </div>
              <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                {sortedListings.map((listing, i) => <ListingCard key={listing.tokenId.toString()} listing={listing} index={i} />)}
              </div>
            </>
          )}
        </section>

        {/* ---------- How it works ---------- */}
        <section className="mt-24">
          <div className="mb-10 max-w-xl">
            <p className="eyebrow mb-2">How a sale works</p>
            <h2 className="font-display text-3xl font-medium tracking-tight text-white sm:text-4xl">Three steps, all on-chain</h2>
          </div>
          <ol className="grid gap-10 md:grid-cols-3 md:gap-8">
            {[
              { n: '01', t: 'The lock stays with the seller', d: 'Listing only grants the market permission to transfer. The veMEZO remains in the seller’s wallet until a buyer pays.' },
              { n: '02', t: 'The price falls on a schedule', d: 'Sellers choose an opening price, a floor and a duration. The ask slides down in a straight line, so buyers can see exactly what it will cost and when.' },
              { n: '03', t: 'One transaction settles it', d: 'The buyer approves MUSD, then buys. The lock and the payment swap in the same transaction, and the hash is yours to verify on Mezo Explorer.' },
            ].map((step, i) => (
              <li key={step.n} className="reveal border-t pt-5" style={{ borderColor: 'rgba(137,147,159,.2)', animationDelay: `${i * 90}ms` }}>
                <span className="font-display text-3xl" style={{ color: '#c45a4c' }}>{step.n}</span>
                <h3 className="mt-3 text-base font-semibold text-white">{step.t}</h3>
                <p className="mt-2 text-sm leading-6" style={{ color: '#89939F' }}>{step.d}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>
    </div>
  )
}
