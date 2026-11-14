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
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Browse Listings</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            Active veMEZO locks for sale on Mezo Testnet
          </p>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300">
            Error: {error}
            <button
              onClick={fetchListings}
              className="ml-4 text-sm underline hover:text-red-900 dark:hover:text-red-100"
            >
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="card animate-pulse">
                <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-4"></div>
                <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/2 mb-2"></div>
                <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3"></div>
              </div>
            ))}
          </div>
        ) : listings.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-gray-500 dark:text-gray-400 text-lg">
              No active listings found
            </div>
            <p className="mt-2 text-gray-400 dark:text-gray-500">
              Listings will appear here when users list their veMEZO locks for sale.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-4 flex justify-between items-center">
              <p className="text-gray-600 dark:text-gray-400">
                Found {listings.length} active listing{listings.length !== 1 ? 's' : ''}
              </p>
              <button
                onClick={fetchListings}
                className="btn-secondary text-sm"
                disabled={loading}
              >
                Refresh
              </button>
            </div>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {listings.map((listing) => (
                <ListingCard key={listing.tokenId.toString()} listing={listing} />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
