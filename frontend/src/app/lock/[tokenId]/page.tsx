'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAccount, usePublicClient, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { parseUnits, formatUnits } from 'viem'
import { Nav } from '@/components/Nav'
import { DEPLOY_BLOCK, LOCKMARKET_ABI, MUSD_ABI, getAddresses } from '@/lib/contracts'
import { formatAddress, formatPrice, formatAmount, formatTime, getErrorMessage, calculateCurrentPrice } from '@/lib/utils'
import { MEZO_TESTNET_ID } from '@/lib/wagmi'

interface LockDetailData {
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

interface ListingData {
  tokenId: bigint
  seller: string
  startPrice: bigint
  endPrice: bigint
  startTime: bigint
  endTime: bigint
  cancelled: boolean
  sold: boolean
}

export default function LockDetailPage({ params }: { params: { tokenId: string } }) {
  const { tokenId } = params
  const tokenIdBigInt = BigInt(tokenId)

  const { address, chainId } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync, data: hash, isPending: isWriting } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const [lockData, setLockData] = useState<LockDetailData | null>(null)
  const [listingData, setListingData] = useState<ListingData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)
  const [buyLoading, setBuyLoading] = useState(false)

  const isMezoTestnet = chainId === MEZO_TESTNET_ID
  const addresses = getAddresses(MEZO_TESTNET_ID)
  const lockMarketAddress = addresses.LockMarket as `0x${string}`
  const musdAddress = addresses.MUSD as `0x${string}`

  const fetchData = useCallback(async () => {
    if (!publicClient) return

    setLoading(true)
    setError(null)

    try {
      // Fetch lock data via inspect
      const lock = await publicClient.readContract({
        address: lockMarketAddress,
        abi: LOCKMARKET_ABI,
        functionName: 'inspect',
        args: [tokenIdBigInt],
      }) as [bigint, bigint, boolean, bigint, boolean, number, string, bigint, boolean]

      const [amount, end, isPermanent, votingPower, voted, escrowType, grantManager, currentPrice, listingActive] = lock

      setLockData({
        tokenId: tokenIdBigInt,
        amount,
        end,
        isPermanent,
        votingPower,
        voted,
        escrowType,
        grantManager,
        currentPrice,
        listingActive,
      })

      // Fetch listing data
      const listing = await publicClient.readContract({
        address: lockMarketAddress,
        abi: LOCKMARKET_ABI,
        functionName: 'getListing',
        args: [tokenIdBigInt],
      }) as [bigint, string, bigint, bigint, bigint, bigint, boolean, boolean]

      const [, seller, startPrice, endPrice, startTime, endTime, cancelled, sold] = listing

      setListingData({
        tokenId: tokenIdBigInt,
        seller,
        startPrice,
        endPrice,
        startTime,
        endTime,
        cancelled,
        sold,
      })
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [publicClient, lockMarketAddress, tokenIdBigInt])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleBuy = async () => {
    if (!address || !publicClient || !listingData || !lockData) {
      setTxError('Connect your wallet and wait for the lock details to load.')
      return
    }

    if (!isMezoTestnet) {
      setTxError('Switch your wallet to Mezo Testnet before buying.')
      return
    }

    setBuyLoading(true)
    setTxError(null)

    try {
      const currentTime = BigInt(Math.floor(Date.now() / 1000))
      const currentPrice = calculateCurrentPrice(
        listingData.startPrice,
        listingData.endPrice,
        listingData.startTime,
        listingData.endTime,
        currentTime
      )

      if (
        !lockData.listingActive ||
        listingData.cancelled ||
        listingData.sold ||
        currentTime > listingData.endTime ||
        currentPrice <= 0n
      ) {
        throw new Error('This listing is no longer available. Refresh the page and try another listing.')
      }

      // Allow a 5% price movement while the wallet confirmation is pending.
      const maxPrice = currentPrice + (currentPrice * 5n / 100n)
      // Protect the buyer against the seller reducing the lock before purchase.
      const minAmount = lockData.amount
      const minEnd = lockData.isPermanent ? 0n : lockData.end

      // Read the current allowance before asking the buyer to approve MUSD.
      let allowance = await publicClient.readContract({
        address: musdAddress,
        abi: MUSD_ABI,
        functionName: 'allowance',
        args: [address, lockMarketAddress],
      }) as bigint

      if (allowance < maxPrice) {
        // Submit approval and WAIT until it is mined before attempting buy().
        const approvalHash = await writeContractAsync({
          address: musdAddress,
          abi: MUSD_ABI,
          functionName: 'approve',
          args: [lockMarketAddress, maxPrice],
        })

        const approvalReceipt = await publicClient.waitForTransactionReceipt({
          hash: approvalHash,
        })

        if (approvalReceipt.status !== 'success') {
          throw new Error('MUSD approval transaction failed. The purchase was not submitted.')
        }

        // Confirm the allowance actually changed on-chain; wallet submission alone is not enough.
        allowance = await publicClient.readContract({
          address: musdAddress,
          abi: MUSD_ABI,
          functionName: 'allowance',
          args: [address, lockMarketAddress],
        }) as bigint

        if (allowance < maxPrice) {
          throw new Error('MUSD approval is confirmed, but the marketplace allowance is still insufficient. Refresh and try again.')
        }
      }

      // Submit the purchase only after the required allowance is confirmed.
      const buyHash = await writeContractAsync({
        address: lockMarketAddress,
        abi: LOCKMARKET_ABI,
        functionName: 'buy',
        args: [tokenIdBigInt, maxPrice, minAmount, minEnd],
      })

      const buyReceipt = await publicClient.waitForTransactionReceipt({
        hash: buyHash,
      })

      if (buyReceipt.status !== 'success') {
        throw new Error('The purchase transaction failed. Check the transaction on the Mezo explorer.')
      }

      await fetchData()
    } catch (err) {
      setTxError(getErrorMessage(err))
    } finally {
      setBuyLoading(false)
    }
  }

  // Refetch after successful transaction
  useEffect(() => {
    if (isSuccess) {
      fetchData()
    }
  }, [isSuccess, fetchData])

  if (loading) {
    return (
      <div className="min-h-screen">
        <Nav />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="animate-pulse">
            <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/4 mb-8"></div>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="card"><div className="h-64 bg-gray-200 dark:bg-gray-700 rounded"></div></div>
              <div className="card"><div className="h-64 bg-gray-200 dark:bg-gray-700 rounded"></div></div>
            </div>
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
            <button onClick={fetchData} className="mt-4 btn-primary">Retry</button>
          </div>
        </main>
      </div>
    )
  }

  if (!lockData || !listingData) {
    return (
      <div className="min-h-screen">
        <Nav />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="text-center py-12">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Lock Not Found</h1>
            <p className="text-gray-600 dark:text-gray-400">This lock does not exist or could not be loaded.</p>
          </div>
        </main>
      </div>
    )
  }

  const currentTime = BigInt(Math.floor(Date.now() / 1000))
  const currentPrice = calculateCurrentPrice(
    listingData.startPrice,
    listingData.endPrice,
    listingData.startTime,
    listingData.endTime,
    currentTime
  )

  const isExpired = currentTime > listingData.endTime
  const isCancelled = listingData.cancelled
  const isSold = listingData.sold
  const isActive = lockData.listingActive && !isExpired && !isCancelled && !isSold
  const isOwner = address && address.toLowerCase() === listingData.seller.toLowerCase()

  const progress = listingData.startTime < currentTime && listingData.endTime > currentTime
    ? Number((currentTime - listingData.startTime) * 100n / (listingData.endTime - listingData.startTime))
    : listingData.endTime <= currentTime ? 100 : 0

  // Do not display a fabricated fair value. A defensible valuation requires live market and incentive inputs.

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
                Lock #{tokenId}
              </h1>
              <p className="mt-1 text-gray-600 dark:text-gray-400">
                Seller: {formatAddress(listingData.seller)}
              </p>
            </div>
            {!isMezoTestnet && (
              <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                <p className="text-yellow-800 dark:text-yellow-200">
                  Please switch to Mezo Testnet to interact with this lock.
                </p>
              </div>
            )}
          </div>
        </div>

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

        {txError && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300">
            Error: {txError}
          </div>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          {/* Lock Details Card */}
          <div className="card">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-4">Lock Details</h2>
            <div className="space-y-4">
              <div>
                <label className="text-sm text-gray-500 dark:text-gray-400">Locked Amount</label>
                <p className="text-2xl font-bold text-gray-900 dark:text-white">
                  {formatAmount(lockData.amount)} MEZO
                </p>
              </div>
              <div>
                <label className="text-sm text-gray-500 dark:text-gray-400">Lock End</label>
                <p className="text-lg font-medium text-gray-900 dark:text-white">
                  {lockData.isPermanent ? 'Permanent' : formatTime(lockData.end)}
                </p>
              </div>
              <div>
                <label className="text-sm text-gray-500 dark:text-gray-400">Voting Power</label>
                <p className="text-lg font-medium text-gray-900 dark:text-white">
                  {formatAmount(lockData.votingPower)}
                </p>
              </div>
              <div>
                <label className="text-sm text-gray-500 dark:text-gray-400">Voted in Current Epoch</label>
                <p className="text-lg font-medium text-gray-900 dark:text-white">
                  {lockData.voted ? 'Yes' : 'No'}
                </p>
              </div>
              <div>
                <label className="text-sm text-gray-500 dark:text-gray-400">Escrow Type</label>
                <p className="text-lg font-medium text-gray-900 dark:text-white">
                  {['NORMAL', 'LOCKED', 'MANAGED'][lockData.escrowType] || 'Unknown'}
                </p>
              </div>
              {lockData.grantManager !== '0x0000000000000000000000000000000000000000' && (
                <div>
                  <label className="text-sm text-gray-500 dark:text-gray-400">Grant Manager</label>
                  <p className="text-lg font-medium text-gray-900 dark:text-white font-mono">
                    {formatAddress(lockData.grantManager)}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Listing Details Card */}
          <div className="card">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-4">
              Listing Details
              <span className={`ml-2 px-2 py-1 text-xs font-medium rounded-full ${
                isActive ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' :
                isExpired ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' :
                isCancelled ? 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300' :
                'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
              }`}>
                {isActive ? 'Active' : isExpired ? 'Expired' : isCancelled ? 'Cancelled' : 'Sold'}
              </span>
            </h2>

            <div className="space-y-4">
              {/* Price Comparison */}
              <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
                <h3 className="font-medium text-gray-900 dark:text-white mb-3">Price Analysis</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm text-gray-500 dark:text-gray-400">Current Dutch Price</label>
                    <p className="text-xl font-bold" style={{ color: "#d58d83" }}>
                      {formatPrice(currentPrice)} MUSD
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-gray-500 dark:text-gray-400">Fair value estimate</label>
                    <p className="text-sm font-semibold" style={{ color: '#D6A84F' }}>
                      Not available
                    </p>
                    <p className="text-xs mt-1" style={{ color: '#89939F' }}>
                      No verified valuation data is connected yet.
                    </p>
                  </div>
                </div>
                <div className="mt-4">
                  <label className="text-sm text-gray-500 dark:text-gray-400">Price Progress</label>
                  <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mt-1">
                    <div
                      className="h-full transition-all duration-300"
                      style={{ background: "#A94438", width: `${Math.min(100, Math.max(0, progress))}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
                    <span>Start: {formatPrice(listingData.startPrice)}</span>
                    <span>End: {formatPrice(listingData.endPrice)}</span>
                  </div>
                </div>
              </div>

              {/* Listing Info */}
              <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500 dark:text-gray-400">Start Price</span>
                  <span className="font-medium">{formatPrice(listingData.startPrice)} MUSD</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500 dark:text-gray-400">End Price</span>
                  <span className="font-medium">{formatPrice(listingData.endPrice)} MUSD</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500 dark:text-gray-400">Listing Start</span>
                  <span className="font-medium">{formatTime(listingData.startTime)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500 dark:text-gray-400">Listing End</span>
                  <span className="font-medium">{formatTime(listingData.endTime)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500 dark:text-gray-400">Time Remaining</span>
                  <span className="font-medium">
                    {isExpired ? 'Expired' : formatTime(listingData.endTime - currentTime)}
                  </span>
                </div>
              </div>

              {/* Buy Button */}
              {isActive && isMezoTestnet && (
                <button
                  onClick={handleBuy}
                  disabled={buyLoading || isWriting || isConfirming}
                  className="w-full btn-primary py-3 text-lg"
                >
                  {buyLoading ? 'Preparing...' : 'Buy Lock'}
                </button>
              )}

              {!isMezoTestnet && isActive && (
                <div className="text-center text-sm text-gray-500 dark:text-gray-400">
                  Connect wallet and switch to Mezo Testnet to buy
                </div>
              )}

              {(isExpired || isCancelled || isSold) && (
                <div className="text-center text-sm text-gray-500 dark:text-gray-400">
                  This listing is no longer available
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Transaction Hash Link */}
        {hash && isSuccess && (
          <div className="mt-6 p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
            <div className="flex items-center justify-between">
              <span className="text-green-800 dark:text-green-200 font-medium">
                Transaction confirmed!
              </span>
              <a
                href={`https://explorer.test.mezo.org/tx/${hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-green-600 dark:text-green-400 underline hover:text-green-800"
              >
                View on Explorer
              </a>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}