'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAccount, usePublicClient, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { parseUnits, formatUnits } from 'viem'
import { Nav } from '@/components/Nav'
import { LOCKMARKET_ABI, veMEZO_ABI, MUSD_ABI, getAddresses } from '@/lib/contracts'
import { formatAddress, formatAmount, formatPrice, getErrorMessage, formatTime } from '@/lib/utils'
import { MEZO_TESTNET_ID } from '@/lib/wagmi'
import { getOwnedTokenIds, readLockDetails } from '@/lib/ownedLocks'

interface UserLock {
  tokenId: bigint
  amount: bigint
  end: bigint
  isPermanent: boolean
  votingPower: bigint
  voted: boolean
  escrowType: number
  grantManager: string
  currentPrice: bigint
  listingActive: boolean
}

interface UserListing {
  tokenId: bigint
  seller: string
  startPrice: bigint
  endPrice: bigint
  startTime: bigint
  endTime: bigint
  cancelled: boolean
  sold: boolean
}

export default function SellPage() {
  const { address, chainId } = useAccount()
  const publicClient = usePublicClient()
  const { writeContract, writeContractAsync, data: hash, isPending: isWriting } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const [userLocks, setUserLocks] = useState<UserLock[]>([])
  const [userListings, setUserListings] = useState<Map<bigint, UserListing>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)
  const [unreadableIds, setUnreadableIds] = useState<string[]>([])

  // Form state
  const [selectedTokenId, setSelectedTokenId] = useState<string>('')
  const [startPrice, setStartPrice] = useState<string>('')
  const [endPrice, setEndPrice] = useState<string>('')
  const [duration, setDuration] = useState<string>('86400') // 1 day default
  const [listingTokenId, setListingTokenId] = useState<bigint | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [cancelLoading, setCancelLoading] = useState<bigint | null>(null)

  const isMezoTestnet = chainId === MEZO_TESTNET_ID
  const addresses = getAddresses(MEZO_TESTNET_ID)
  const lockMarketAddress = addresses.LockMarket as `0x${string}`
  const veMEZOAddress = addresses.veMEZO as `0x${string}`

  const fetchUserLocks = useCallback(async () => {
    if (!address || !publicClient) return

    setLoading(true)
    setError(null)

    try {
      const tokenIds = await getOwnedTokenIds(publicClient as any, veMEZOAddress, address)

      const locks: UserLock[] = []
      const failed: string[] = []

      for (const tokenId of tokenIds) {
        try {
          const d = await readLockDetails(publicClient as any, veMEZOAddress, lockMarketAddress, LOCKMARKET_ABI, tokenId)
          locks.push({
            tokenId,
            amount: d.amount,
            end: d.end,
            isPermanent: d.isPermanent,
            votingPower: d.votingPower,
            voted: d.voted,
            escrowType: d.escrowType,
            grantManager: d.grantManager,
            currentPrice: d.currentPrice,
            listingActive: d.listingActive,
          })
        } catch (err) {
          console.warn(`Failed to fetch lock ${tokenId}:`, err)
          failed.push(tokenId.toString())
        }
      }

      setUserLocks(locks)
      setUnreadableIds(failed)

      // Fetch listings for each lock
      const listingsMap = new Map<bigint, UserListing>()
      for (const lock of locks) {
        try {
          const listing = await publicClient.readContract({
            address: lockMarketAddress,
            abi: LOCKMARKET_ABI,
            functionName: 'getListing',
            args: [lock.tokenId],
          }) as [bigint, string, bigint, bigint, bigint, bigint, boolean, boolean]

          const [, seller, startPrice, endPrice, startTime, endTime, cancelled, sold] = listing

          listingsMap.set(lock.tokenId, {
            tokenId: lock.tokenId,
            seller,
            startPrice,
            endPrice,
            startTime,
            endTime,
            cancelled,
            sold,
          })
        } catch (err) {
          console.warn(`Failed to fetch listing for ${lock.tokenId}:`, err)
        }
      }

      setUserListings(listingsMap)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [address, publicClient, veMEZOAddress, lockMarketAddress])

  useEffect(() => {
    fetchUserLocks()
  }, [fetchUserLocks])

  // Refetch after successful transaction
  useEffect(() => {
    if (isSuccess) {
      fetchUserLocks()
    }
  }, [isSuccess, fetchUserLocks])

  const handleApprove = async (tokenId: bigint) => {
    if (!publicClient) return

    try {
      const isApproved = await publicClient.readContract({
        address: veMEZOAddress,
        abi: veMEZO_ABI,
        functionName: 'isApprovedForAll',
        args: [address!, lockMarketAddress],
      }) as boolean

      if (!isApproved) {
        const approveHash = await writeContractAsync({
          address: veMEZOAddress,
          abi: veMEZO_ABI,
          functionName: 'setApprovalForAll',
          args: [lockMarketAddress, true],
        })
        await publicClient.waitForTransactionReceipt({ hash: approveHash })
      }
    } catch (err) {
      throw new Error(getErrorMessage(err))
    }
  }

  const handleList = async () => {
    if (!selectedTokenId || !startPrice || !endPrice || !duration) return

    setListLoading(true)
    setTxError(null)
    setListingTokenId(BigInt(selectedTokenId))

    try {
      // Approve first
      await handleApprove(BigInt(selectedTokenId))

      const startPriceWei = parseUnits(startPrice, 18)
      const endPriceWei = parseUnits(endPrice, 18)
      const durationSec = BigInt(duration)

      // Validate endPrice <= startPrice
      if (endPriceWei > startPriceWei) {
        throw new Error('End price must be less than or equal to start price')
      }

      if (durationSec <= 0n) {
        throw new Error('Duration must be greater than 0')
      }

      await writeContractAsync({
        address: lockMarketAddress,
        abi: LOCKMARKET_ABI,
        functionName: 'list',
        args: [BigInt(selectedTokenId), startPriceWei, endPriceWei, durationSec],
      })
    } catch (err) {
      setTxError(getErrorMessage(err))
    } finally {
      setListLoading(false)
      setListingTokenId(null)
    }
  }

  const handleCancel = async (tokenId: bigint) => {
    setCancelLoading(tokenId)
    setTxError(null)

    try {
      await writeContract({
        address: lockMarketAddress,
        abi: LOCKMARKET_ABI,
        functionName: 'cancel',
        args: [tokenId],
      })
    } catch (err) {
      setTxError(getErrorMessage(err))
    } finally {
      setCancelLoading(null)
    }
  }

  const selectedLock = userLocks.find(l => l.tokenId.toString() === selectedTokenId)
  const selectedListing = selectedTokenId ? userListings.get(BigInt(selectedTokenId)) : null

  if (loading) {
    return (
      <div className="min-h-screen">
        <Nav />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="animate-pulse">
            <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/4 mb-8"></div>
            <div className="card"><div className="h-64 bg-gray-200 dark:bg-gray-700 rounded"></div></div>
          </div>
        </main>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen">
        <Nav />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="text-center py-12">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Error</h1>
            <p className="text-red-600 dark:text-red-400">{error}</p>
            <button onClick={fetchUserLocks} className="mt-4 btn-primary">Retry</button>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <section className="mb-8 rounded-2xl p-6 sm:p-8" style={{ background: 'linear-gradient(110deg,rgba(55,35,35,.8),rgba(29,33,39,.96))', border: '1px solid rgba(214,168,79,.18)' }}>
          <p className="eyebrow mb-3">Seller workspace / Mezo Testnet</p>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-white">Manage your positions</h1>
          <p className="mt-3 max-w-2xl text-sm sm:text-base leading-6" style={{ color: '#aeb6c0' }}>
            Review your veMEZO locks, check listing eligibility and create a transparent sale listing. Your NFT remains in your wallet until a buyer completes the purchase.
          </p>
          <div className="mt-6 flex flex-wrap gap-3 text-xs">
            <span className="rounded-full px-3 py-2" style={{ background: 'rgba(214,168,79,.1)', color: '#e2c27e', border: '1px solid rgba(214,168,79,.18)' }}>Non-custodial listing</span>
            <span className="rounded-full px-3 py-2" style={{ background: 'rgba(169,68,56,.13)', color: '#e0a39a', border: '1px solid rgba(196,90,76,.2)' }}>MUSD settlement</span>
          </div>
        </section>

        {!isMezoTestnet && (
          <div className="mb-6 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <p className="text-yellow-800 dark:text-yellow-200">
              Please switch to Mezo Testnet to list your locks.
            </p>
          </div>
        )}

        {!address && (
          <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
            <p className="text-blue-800 dark:text-blue-200">
              Connect your wallet to see your veMEZO locks.
            </p>
          </div>
        )}

        {unreadableIds.length > 0 && (
          <div className="mb-6 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <p className="text-yellow-800 dark:text-yellow-200">
              Found veMEZO lock{unreadableIds.length > 1 ? 's' : ''} #{unreadableIds.join(', #')} in your wallet, but couldn't read {unreadableIds.length > 1 ? 'their' : 'its'} details from the Mezo network. Please retry in a moment.
            </p>
          </div>
        )}

        {userLocks.length === 0 && unreadableIds.length === 0 && address && (
          <div className="text-center py-12">
            <div className="text-gray-500 dark:text-gray-400 text-lg">No veMEZO locks found</div>
            <p className="mt-2 text-gray-400 dark:text-gray-500">
              You don't own any veMEZO NFTs on this network.
            </p>
          </div>
        )}

        {/* User Locks Table */}
        {userLocks.length > 0 && (
          <div className="card mb-8">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-4">Your Locks</h2>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-sm text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="pb-3 font-medium">Token ID</th>
                    <th className="pb-3 font-medium">Amount (MEZO)</th>
                    <th className="pb-3 font-medium">Lock End</th>
                    <th className="pb-3 font-medium">Voting Power</th>
                    <th className="pb-3 font-medium">Escrow Type</th>
                    <th className="pb-3 font-medium">Status</th>
                    <th className="pb-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {userLocks.map((lock) => {
                    const rawListing = userListings.get(lock.tokenId)
                    // A never-listed token comes back from getListing() as an all-zero struct
                    const listing = rawListing && rawListing.seller !== '0x0000000000000000000000000000000000000000' ? rawListing : undefined
                    const isListed = listing && !listing.cancelled && !listing.sold
                    const currentTime = BigInt(Math.floor(Date.now() / 1000))
                    const isExpired = listing && currentTime > listing.endTime

                    return (
                      <tr key={lock.tokenId.toString()} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                        <td className="py-3 font-mono text-sm">#{lock.tokenId.toString()}</td>
                        <td className="py-3">{formatAmount(lock.amount)}</td>
                        <td className="py-3">
                          {lock.isPermanent ? 'Permanent' : formatTime(lock.end)}
                        </td>
                        <td className="py-3">{formatAmount(lock.votingPower)}</td>
                        <td className="py-3">
                          {['NORMAL', 'LOCKED', 'MANAGED'][lock.escrowType] || 'Unknown'}
                        </td>
                        <td className="py-3">
                          {isListed && !isExpired ? (
                            <span className="px-2 py-1 text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 rounded-full">
                              Listed
                            </span>
                          ) : isExpired ? (
                            <span className="px-2 py-1 text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 rounded-full">
                              Expired
                            </span>
                          ) : listing?.cancelled ? (
                            <span className="px-2 py-1 text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300 rounded-full">
                              Cancelled
                            </span>
                          ) : listing?.sold ? (
                            <span className="px-2 py-1 text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 rounded-full">
                              Sold
                            </span>
                          ) : (
                            <span className="px-2 py-1 text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300 rounded-full">
                              Available
                            </span>
                          )}
                        </td>
                        <td className="py-3">
                          {lock.escrowType !== 0 && (
                            <span className="text-sm text-gray-500 dark:text-gray-400">
                              Cannot list (not NORMAL escrow)
                            </span>
                          )}
                          {lock.escrowType === 0 && !isListed && !isExpired && (
                            <button
                              onClick={() => setSelectedTokenId(lock.tokenId.toString())}
                              className="btn-primary text-sm"
                            >
                              List
                            </button>
                          )}
                          {isListed && !isExpired && (
                            <button
                              onClick={() => handleCancel(lock.tokenId)}
                              disabled={cancelLoading === lock.tokenId}
                              className="btn-secondary text-sm"
                            >
                              {cancelLoading === lock.tokenId ? 'Cancelling...' : 'Cancel'}
                            </button>
                          )}
                          {isListed && isExpired && (
                            <button
                              onClick={() => handleCancel(lock.tokenId)}
                              disabled={cancelLoading === lock.tokenId}
                              className="btn-secondary text-sm"
                            >
                              {cancelLoading === lock.tokenId ? 'Cancelling...' : 'Cancel Expired'}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* List Form */}
        {selectedTokenId && selectedLock && (
          <div className="card mb-8">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-4">
              List Lock #{selectedTokenId}
            </h2>
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Start Price (MUSD)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={startPrice}
                  onChange={(e) => setStartPrice(e.target.value)}
                  className="input-field"
                  placeholder="e.g., 1000"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  End Price (MUSD)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={endPrice}
                  onChange={(e) => setEndPrice(e.target.value)}
                  className="input-field"
                  placeholder="e.g., 500"
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Must be ≤ start price. Equal = fixed price.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Duration (seconds)
                </label>
                <input
                  type="number"
                  min="1"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  className="input-field"
                  placeholder="86400 (1 day)"
                />
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end space-x-3">
              <button
                onClick={() => setSelectedTokenId('')}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleList}
                disabled={listLoading || !isMezoTestnet}
                className="btn-primary"
              >
                {listLoading ? 'Listing...' : 'List for Sale'}
              </button>
            </div>

            {txError && (
              <div className="mt-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300">
                Error: {txError}
              </div>
            )}
          </div>
        )}

        {/* Transaction status */}
        {(isWriting || isConfirming) && (
          <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
            <div className="flex items-center space-x-2">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
              <span className="text-blue-800 dark:text-blue-200">
                {isWriting ? 'Submitting transaction...' : 'Confirming transaction...'}
              </span>
              {hash && (
                <a
                  href={`https://explorer.test.mezo.org/tx/${hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 underline ml-2"
                >
                  View on Explorer
                </a>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
