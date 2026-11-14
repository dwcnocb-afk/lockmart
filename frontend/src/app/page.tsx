'use client'

import { useState, useEffect, useCallback } from 'react'
import { createPublicClient, http, parseAbiItem, Abi, Log, Chain } from 'viem'
import { MEZO_TESTNET_ID, MEZO_TESTNET_RPC, MEZO_TESTNET_NAME, MEZO_TESTNET_EXPLORER } from '@/lib/wagmi'
import { Nav } from '@/components/Nav'
import { ListingCard } from '@/components/ListingCard'
import { DEPLOY_BLOCK, LOCKMARKET_ABI, getAddresses } from '@/lib/contracts'
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

      // Create sets of cancelled and sold tokenIds
      const cancelledTokenIds = new Set(cancelledLogs.map(log => log.args.tokenId))
      const soldTokenIds = new Set(soldLogs.map(log => log.args.tokenId))

      // Get unique tokenIds from Listed events (latest event per tokenId wins)
      const tokenIdMap = new Map<bigint, ListedLog>()
      for (const log of allLogs) {
        const tokenId = log.args.tokenId
        // Keep the latest listing event (by block number)
        const existing = tokenIdMap.get(tokenId)
        if (!existing || log.blockNumber! > existing.blockNumber!) {
          tokenIdMap.set(tokenId, log)
        }
      }

      // Fetch details for each unique tokenId
      const listingDetails: ListingWithDetails[] = []

      for (const [tokenId, log] of tokenIdMap) {
        // Skip if cancelled or sold
        if (cancelledTokenIds.has(tokenId) || soldTokenIds.has(tokenId)) {
          continue
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

          // Get lock details (inspect)
          const lockData = await publicClient.readContract({
            address: lockMarketAddress,
            abi: LOCKMARKET_ABI,
            functionName: 'inspect',
            args: [tokenId],
          }) as [bigint, bigint, boolean, bigint, boolean, number, string, bigint, boolean]

          const [amount, end, isPermanent, , , , , currentPrice, listingActive] = lockData

          // Skip if not actively listed
          if (!listingActive) continue

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

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
        <section className="relative overflow-hidden rounded-3xl mt-7 sm:mt-10 mb-10 p-6 sm:p-10 lg:p-14" style={{ background: 'linear-gradient(115deg,rgba(43,35,36,.98),rgba(29,33,39,.98) 58%,rgba(38,31,30,.96))', border: '1px solid rgba(214,168,79,.18)' }}>
          <div className="absolute -right-20 -top-28 w-80 h-80 rounded-full blur-3xl pointer-events-none" style={{ background: 'rgba(169,68,56,.18)' }} />
          <div className="absolute right-12 bottom-0 w-48 h-48 rounded-full blur-3xl pointer-events-none" style={{ background: 'rgba(214,168,79,.08)' }} />
          <div className="relative max-w-3xl">
            <div className="eyebrow mb-5 flex items-center gap-2"><span className="w-6 h-px" style={{ background: '#D6A84F' }} /> MEZO TESTNET · veMEZO SECONDARY MARKET</div>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight leading-[1.08] text-white text-balance">
              Your veMEZO position.<br /><span style={{ color: '#d58d83' }}>Your liquidity.</span>
            </h1>
            <p className="mt-5 max-w-xl text-base sm:text-lg leading-7" style={{ color: '#aeb6c0' }}>
              Discover tokenized lock positions, compare live asking prices and trade through a non-custodial marketplace built for Mezo.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3">
              <a href="#marketplace" className="btn-primary">Explore marketplace <span aria-hidden>→</span></a>
              <a href="/sell" className="btn-secondary">List your veMEZO lock</a>
            </div>
          </div>
          <div className="relative mt-10 pt-6 border-t grid grid-cols-2 sm:grid-cols-3 gap-5" style={{ borderColor: 'rgba(137,147,159,.18)' }}>
            <div><p className="data-label mb-1">Active listings</p><p className="text-2xl font-semibold text-white tabular-nums">{loading ? '—' : listings.length}</p></div>
            <div><p className="data-label mb-1">Settlement asset</p><p className="text-2xl font-semibold" style={{ color: '#D6A84F' }}>MUSD</p></div>
            <div className="col-span-2 sm:col-span-1"><p className="data-label mb-1">Execution model</p><p className="text-base font-semibold text-white">Non-custodial</p></div>
          </div>
        </section>

        <section id="marketplace" className="scroll-mt-28">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
            <div>
              <p className="eyebrow mb-2">The marketplace</p>
              <h2 className="text-2xl sm:text-3xl font-semibold text-white tracking-tight">Available positions</h2>
              <p className="mt-2 text-sm" style={{ color: '#89939F' }}>Browse active veMEZO locks listed by their holders.</p>
            </div>
            <button onClick={fetchListings} className="btn-secondary self-start sm:self-auto" disabled={loading}>
              {loading ? 'Refreshing…' : '↻ Refresh listings'}
            </button>
          </div>

          {error && (
            <div className="mb-6 p-4 rounded-xl border text-sm" style={{ background: 'rgba(169,68,56,.12)', borderColor: 'rgba(196,90,76,.3)', color: '#e5b7b0' }}>
              <span className="font-semibold">Unable to load listings.</span> {error}
              <button onClick={fetchListings} className="ml-3 underline underline-offset-4">Try again</button>
            </div>
          )}

          {loading ? (
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="card animate-pulse">
                  <div className="h-3 rounded w-1/3 mb-6" style={{ background: '#343c46' }} />
                  <div className="h-8 rounded w-2/3 mb-5" style={{ background: '#343c46' }} />
                  <div className="h-24 rounded mb-4" style={{ background: '#292f37' }} />
                  <div className="h-8 rounded" style={{ background: '#343c46' }} />
                </div>
              ))}
            </div>
          ) : listings.length === 0 ? (
            <div className="rounded-2xl p-10 sm:p-14 text-center" style={{ background: 'rgba(28,32,38,.72)', border: '1px dashed rgba(137,147,159,.3)' }}>
              <div className="w-14 h-14 rounded-2xl mx-auto mb-5 flex items-center justify-center text-2xl" style={{ background: 'rgba(169,68,56,.16)', color: '#d58d83' }}>⌁</div>
              <p className="text-xl font-semibold text-white">No active positions yet</p>
              <p className="mt-2 max-w-md mx-auto text-sm leading-6" style={{ color: '#89939F' }}>When holders list eligible veMEZO locks, they will appear here with live asking prices and lock details.</p>
              <a href="/sell" className="btn-primary mt-6">Be the first to list</a>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-4 text-xs" style={{ color: '#89939F' }}>
                <span>{listings.length} active position{listings.length !== 1 ? 's' : ''} found</span>
                <span className="font-mono">Latest scan · block {lastScannedBlock.toString()}</span>
              </div>
              <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                {listings.map(listing => <ListingCard key={listing.tokenId.toString()} listing={listing} />)}
              </div>
            </>
          )}
        </section>

        <section className="mt-12 grid gap-4 md:grid-cols-3">
          <div className="surface-panel p-5"><p className="eyebrow mb-2">01 / Retain custody</p><h3 className="font-semibold text-white mb-2">Your NFT stays yours</h3><p className="text-sm leading-6" style={{ color: '#89939F' }}>The seller keeps the veMEZO position until a buyer completes the on-chain purchase.</p></div>
          <div className="surface-panel p-5"><p className="eyebrow mb-2">02 / Clear execution</p><h3 className="font-semibold text-white mb-2">Dutch or fixed pricing</h3><p className="text-sm leading-6" style={{ color: '#89939F' }}>Listings expose their start price, end price and live asking price before you commit.</p></div>
          <div className="surface-panel p-5"><p className="eyebrow mb-2">03 / Verifiable</p><h3 className="font-semibold text-white mb-2">On-chain settlement</h3><p className="text-sm leading-6" style={{ color: '#89939F' }}>Transactions execute through the LockMarket contract and can be checked on Mezo Explorer.</p></div>
        </section>
      </main>
    </div>
  )
}
