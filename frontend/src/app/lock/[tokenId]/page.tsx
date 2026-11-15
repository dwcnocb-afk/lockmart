'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { Nav } from '@/components/Nav'
import { CopyButton, PriceCurve, StatusPill, Term, getStatus, useNow } from '@/components/ui'
import { useChainContext } from '@/app/chain-provider'
import { LOCKMARKET_ABI, MUSD_ABI, getAddresses } from '@/lib/contracts'
import { readLockDetails } from '@/lib/ownedLocks'
import { formatAddress, formatPrice, formatAmount, formatTime, getErrorMessage, calculateCurrentPrice } from '@/lib/utils'
import { MEZO_TESTNET_ID, MEZO_TESTNET_EXPLORER } from '@/lib/wagmi'

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

type BuyStep = 'idle' | 'balance' | 'approve-wallet' | 'approve-wait' | 'buy-wallet' | 'buy-wait' | 'done'

function formatCountdown(totalSeconds: bigint): string {
  const t = Number(totalSeconds > 0n ? totalSeconds : 0n)
  const d = Math.floor(t / 86400)
  const h = Math.floor((t % 86400) / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = t % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m`
  return `${pad(h)}:${pad(m)}:${pad(sec)}`
}

// Declared at module scope so it keeps its identity across the 1s price ticks.
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <Nav />
      <main id="main" className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">{children}</main>
    </div>
  )
}

export default function LockDetailPage({ params }: { params: { tokenId: string } }) {
  const { tokenId } = params
  const tokenIdBigInt = BigInt(tokenId)

  const { address, chainId } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const { connectWallet, switchNetwork, isSwitching } = useChainContext()
  const now = useNow(1000)

  const [lockData, setLockData] = useState<LockDetailData | null>(null)
  const [listingData, setListingData] = useState<ListingData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)
  const [buyLoading, setBuyLoading] = useState(false)
  const [buyStep, setBuyStep] = useState<BuyStep>('idle')
  const [needsApproval, setNeedsApproval] = useState<boolean | null>(null)
  const [approveTx, setApproveTx] = useState<string | null>(null)
  const [buyTx, setBuyTx] = useState<string | null>(null)
  const [musdBalance, setMusdBalance] = useState<bigint | null>(null)
  const [feeBps, setFeeBps] = useState<bigint | null>(null)

  const isMezoTestnet = chainId === MEZO_TESTNET_ID
  const addresses = getAddresses(MEZO_TESTNET_ID)
  const lockMarketAddress = addresses.LockMarket as `0x${string}`
  const musdAddress = addresses.MUSD as `0x${string}`
  const veMEZOAddress = addresses.veMEZO as `0x${string}`

  const fetchData = useCallback(async () => {
    if (!publicClient) return

    setLoading(true)
    setError(null)

    try {
      // Read the lock. inspect() can revert if any veMEZO getter misbehaves, so
      // readLockDetails falls back to reading veMEZO directly.
      const d = await readLockDetails(
        publicClient as any,
        veMEZOAddress,
        lockMarketAddress,
        LOCKMARKET_ABI,
        tokenIdBigInt,
      )

      // Fetch listing data
      const listing = await publicClient.readContract({
        address: lockMarketAddress,
        abi: LOCKMARKET_ABI,
        functionName: 'getListing',
        args: [tokenIdBigInt],
      }) as [bigint, string, bigint, bigint, bigint, bigint, boolean, boolean]

      const [, seller, startPrice, endPrice, startTime, endTime, cancelled, sold] = listing

      // The listing getter is the source of truth for listing status.
      const now = BigInt(Math.floor(Date.now() / 1000))
      const listingActive =
        seller !== '0x0000000000000000000000000000000000000000' &&
        !cancelled &&
        !sold &&
        now <= endTime

      setLockData({
        tokenId: tokenIdBigInt,
        amount: d.amount,
        end: d.end,
        isPermanent: d.isPermanent,
        votingPower: d.votingPower,
        voted: d.voted,
        escrowType: d.escrowType,
        grantManager: d.grantManager,
        currentPrice: d.currentPrice,
        listingActive,
      })

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
  }, [publicClient, lockMarketAddress, veMEZOAddress, tokenIdBigInt])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Non-critical reads: the buyer's MUSD balance and the market fee. Failures are ignored.
  const refreshBalance = useCallback(async () => {
    if (!address || !publicClient) { setMusdBalance(null); return }
    try {
      const b = (await publicClient.readContract({ address: musdAddress, abi: MUSD_ABI, functionName: 'balanceOf', args: [address] })) as bigint
      setMusdBalance(b)
    } catch { setMusdBalance(null) }
  }, [address, publicClient, musdAddress])

  useEffect(() => { refreshBalance() }, [refreshBalance])

  useEffect(() => {
    if (!publicClient) return
    publicClient
      .readContract({ address: lockMarketAddress, abi: LOCKMARKET_ABI, functionName: 'feeBps' })
      .then(v => setFeeBps(v as bigint))
      .catch(() => setFeeBps(null))
  }, [publicClient, lockMarketAddress])

  const handleBuy = async () => {
    if (!address || !listingData || !lockData || !publicClient) return

    setBuyLoading(true)
    setTxError(null)
    setBuyStep('balance')
    setApproveTx(null)
    setBuyTx(null)

    try {
      const currentTime = BigInt(Math.floor(Date.now() / 1000))
      const currentPrice = calculateCurrentPrice(
        listingData.startPrice,
        listingData.endPrice,
        listingData.startTime,
        listingData.endTime,
        currentTime
      )

      // 5% slippage on maxPrice, no minimums on amount/end
      const maxPrice = currentPrice + (currentPrice * 5n) / 100n
      const minAmount = 0n
      const minEnd = 0n

      // 1. Preflight: does the buyer have enough MUSD?
      const balance = (await publicClient.readContract({
        address: musdAddress,
        abi: MUSD_ABI,
        functionName: 'balanceOf',
        args: [address],
      })) as bigint
      setMusdBalance(balance)

      if (balance < currentPrice) {
        setTxError(
          `Not enough MUSD. This lock costs ${formatPrice(currentPrice)} MUSD and your wallet has ${formatPrice(balance)} MUSD.`
        )
        setBuyStep('idle')
        return
      }

      // 2. Approve MUSD if needed, and wait for it to be mined
      const allowance = (await publicClient.readContract({
        address: musdAddress,
        abi: MUSD_ABI,
        functionName: 'allowance',
        args: [address, lockMarketAddress],
      })) as bigint

      if (allowance < maxPrice) {
        setNeedsApproval(true)
        setBuyStep('approve-wallet')
        const approveHash = await writeContractAsync({
          address: musdAddress,
          abi: MUSD_ABI,
          functionName: 'approve',
          args: [lockMarketAddress, maxPrice],
        })
        setApproveTx(approveHash)
        setBuyStep('approve-wait')
        const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
        if (approveReceipt.status !== 'success') {
          setTxError('The MUSD approval failed. Please try again.')
          setBuyStep('idle')
          return
        }
      } else {
        setNeedsApproval(false)
      }

      // 3. Buy
      setBuyStep('buy-wallet')
      const buyHash = await writeContractAsync({
        address: lockMarketAddress,
        abi: LOCKMARKET_ABI,
        functionName: 'buy',
        args: [tokenIdBigInt, maxPrice, minAmount, minEnd],
      })
      setBuyTx(buyHash)
      setBuyStep('buy-wait')
      const buyReceipt = await publicClient.waitForTransactionReceipt({ hash: buyHash })
      if (buyReceipt.status !== 'success') {
        setTxError('The purchase transaction reverted. The listing may have changed, so refresh and try again.')
        setBuyStep('idle')
        return
      }

      setBuyStep('done')
      fetchData()
      refreshBalance()
    } catch (err) {
      setTxError(getErrorMessage(err))
      setBuyStep('idle')
    } finally {
      setBuyLoading(false)
    }
  }

  // Only show the full-page skeleton on the first load; later refreshes are silent.
  if (loading && !lockData) {
    return (
      <Shell>
        <div aria-busy="true" aria-label="Loading lock">
          <div className="skeleton mb-3 h-4 w-28" />
          <div className="skeleton mb-10 h-12 w-72" />
          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <div className="space-y-6">
              <div className="skeleton h-72 rounded-2xl" />
              <div className="skeleton h-64 rounded-2xl" />
            </div>
            <div className="skeleton h-96 rounded-2xl" />
          </div>
        </div>
      </Shell>
    )
  }

  if (error && !lockData) {
    return (
      <Shell>
        <div className="mx-auto max-w-md py-16 text-center">
          <h1 className="font-display text-3xl font-medium text-white">We couldn&apos;t load this lock</h1>
          <p role="alert" className="mt-3 text-sm leading-6" style={{ color: '#e5b7b0' }}>{error}</p>
          <div className="mt-6 flex justify-center gap-3">
            <button onClick={fetchData} className="btn-primary">Retry</button>
            <Link href="/" className="btn-secondary">Back to marketplace</Link>
          </div>
        </div>
      </Shell>
    )
  }

  if (!lockData || !listingData) {
    return (
      <Shell>
        <div className="mx-auto max-w-md py-16 text-center">
          <h1 className="font-display text-3xl font-medium text-white">Lock not found</h1>
          <p className="mt-3 text-sm leading-6" style={{ color: '#89939F' }}>This lock doesn&apos;t exist on the current LockMarket deployment, or it could not be read.</p>
          <Link href="/" className="btn-secondary mt-6">Back to marketplace</Link>
        </div>
      </Shell>
    )
  }

  const currentPrice = calculateCurrentPrice(listingData.startPrice, listingData.endPrice, listingData.startTime, listingData.endTime, now)
  const status = getStatus({ now, endTime: listingData.endTime, cancelled: listingData.cancelled, sold: listingData.sold })
  const isUnavailable = status === 'expired' || status === 'sold' || status === 'cancelled'
  const isActive = lockData.listingActive && !isUnavailable
  const isOwner = !!address && address.toLowerCase() === listingData.seller.toLowerCase()
  const purchased = buyStep === 'done'

  const discountBps = listingData.startPrice > 0n && listingData.startPrice > currentPrice
    ? Number(((listingData.startPrice - currentPrice) * 10000n) / listingData.startPrice)
    : 0
  const perMezo = lockData.amount > 0n ? Number((currentPrice * 10000n) / lockData.amount) / 10000 : null
  const maxPrice = currentPrice + (currentPrice * 5n) / 100n
  const [whole, frac = ''] = formatPrice(currentPrice).split('.')
  const insufficient = musdBalance !== null && musdBalance < currentPrice
  const busy = buyLoading || buyStep === 'approve-wallet' || buyStep === 'approve-wait' || buyStep === 'buy-wallet' || buyStep === 'buy-wait'

  const stepLabel: Record<BuyStep, string> = {
    idle: 'Buy this lock',
    balance: 'Checking your balance…',
    'approve-wallet': 'Approve MUSD in your wallet…',
    'approve-wait': 'Waiting for approval…',
    'buy-wallet': 'Confirm the purchase in your wallet…',
    'buy-wait': 'Settling on-chain…',
    done: 'Purchased',
  }

  const steps = [
    { key: 'approve', label: needsApproval === false ? 'MUSD approval already in place' : 'Approve MUSD spending', active: buyStep === 'approve-wallet' || buyStep === 'approve-wait', done: needsApproval === false || ['buy-wallet', 'buy-wait', 'done'].includes(buyStep), skipped: needsApproval === false },
    { key: 'buy', label: 'Confirm purchase', active: buyStep === 'buy-wallet' || buyStep === 'buy-wait', done: buyStep === 'done', skipped: false },
  ]

  const explorerTx = (h: string) => `${MEZO_TESTNET_EXPLORER}/tx/${h}`

  return (
    <Shell>
      <Link href="/" className="mb-6 inline-flex items-center gap-2 text-sm transition-colors hover:text-white" style={{ color: '#89939F' }}>
        <span aria-hidden>←</span> All listings
      </Link>

      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-3 flex items-center gap-3">
            <StatusPill status={status} />
            <span className="eyebrow">veMEZO position</span>
          </div>
          <h1 className="font-display text-4xl font-medium tracking-tight text-white sm:text-5xl">Lock #{tokenId}</h1>
        </div>
        <div className="flex items-center gap-2 text-sm" style={{ color: '#89939F' }}>
          Listed by
          <span className="font-mono" style={{ color: '#d8dde3' }}>{formatAddress(listingData.seller)}</span>
          <CopyButton value={listingData.seller} />
        </div>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[1.4fr_1fr]">
        {/* ---------------- Left: price + position ---------------- */}
        <div className="space-y-6">
          <section className="rounded-2xl p-6 sm:p-8" style={{ background: 'linear-gradient(160deg,rgba(34,40,49,.9),rgba(22,25,30,.98))', border: '1px solid rgba(137,147,159,.16)' }} aria-label="Price">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="data-label mb-2">
                  Price right now · <Term tip="The ask falls in a straight line from the opening price to the floor. It is recalculated every second here, and again by the contract when you buy.">falling-price auction</Term>
                </p>
                <div className="flex items-baseline gap-2">
                  <span className="font-display text-6xl font-medium leading-none tracking-tight text-white tabular sm:text-7xl">
                    {whole}
                    {frac && <span className="text-3xl sm:text-4xl" style={{ color: '#aeb6c0' }}>.{frac}</span>}
                  </span>
                  <span className="text-lg font-medium" style={{ color: '#D6A84F' }}>MUSD</span>
                </div>
              </div>
              {discountBps > 0 && !isUnavailable && (
                <div className="rounded-xl px-4 py-3 text-right" style={{ background: 'rgba(214,168,79,.08)', border: '1px solid rgba(214,168,79,.22)' }}>
                  <p className="font-display text-2xl font-medium tabular" style={{ color: '#e0bd77' }}>−{(discountBps / 100).toFixed(discountBps >= 1000 ? 0 : 1)}%</p>
                  <p className="text-[11px]" style={{ color: '#89939F' }}>below opening ask</p>
                </div>
              )}
            </div>

            <div className="mt-6">
              <PriceCurve startPrice={listingData.startPrice} endPrice={listingData.endPrice} startTime={listingData.startTime} endTime={listingData.endTime} now={now} height={110} muted={isUnavailable} />
              <div className="mt-2 flex justify-between text-xs tabular" style={{ color: '#89939F' }}>
                <span>Opened at {formatPrice(listingData.startPrice)}</span>
                <span>Floor {formatPrice(listingData.endPrice)}</span>
              </div>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-4 border-t pt-5 sm:grid-cols-3" style={{ borderColor: 'rgba(137,147,159,.14)' }}>
              <div>
                <p className="data-label mb-1">Auction ends in</p>
                <p className="font-display text-xl font-medium tabular" style={{ color: status === 'ending' ? '#e5a79d' : '#fff' }}>
                  {isUnavailable ? '—' : formatCountdown(listingData.endTime - now)}
                </p>
              </div>
              <div>
                <p className="data-label mb-1"><Term tip="Price per MEZO locked. Handy for comparing listings of different sizes.">Cost per MEZO</Term></p>
                <p className="font-display text-xl font-medium tabular text-white">{perMezo === null ? '—' : perMezo.toFixed(4)}</p>
              </div>
              <div className="col-span-2 sm:col-span-1">
                <p className="data-label mb-1">
                  <Term tip="A reference valuation needs live market and incentive inputs. Lockmart shows none rather than a number it can't back up.">Fair-value reference</Term>
                </p>
                <p className="text-sm font-medium" style={{ color: '#89939F' }}>Not connected yet</p>
              </div>
            </div>
          </section>

          <section className="rounded-2xl p-6 sm:p-8" style={{ background: 'rgba(27,31,37,.7)', border: '1px solid rgba(137,147,159,.14)' }} aria-label="Lock details">
            <h2 className="font-display text-2xl font-medium text-white">What you&apos;d be buying</h2>
            <p className="mt-1 text-sm" style={{ color: '#89939F' }}>Read directly from the veMEZO contract.</p>
            <dl className="mt-6 space-y-3.5">
              <div className="ledger-row"><dt>Locked amount</dt><dd>{formatAmount(lockData.amount)} MEZO</dd></div>
              <div className="ledger-row"><dt>Unlocks</dt><dd>{lockData.isPermanent ? 'Permanent' : formatTime(lockData.end)}</dd></div>
              <div className="ledger-row"><dt><Term tip="The voting weight this lock carries right now. It decays as the unlock date approaches, unless the lock is permanent.">Voting power</Term></dt><dd>{formatAmount(lockData.votingPower)}</dd></div>
              <div className="ledger-row"><dt><Term tip="Locks that have already voted in the current epoch can be restricted from certain actions until the next one.">Voted this epoch</Term></dt><dd>{lockData.voted ? 'Yes' : 'No'}</dd></div>
              <div className="ledger-row"><dt><Term tip="Only NORMAL locks can be listed on Lockmart. Locked and managed escrows are excluded.">Escrow type</Term></dt><dd>{['NORMAL', 'LOCKED', 'MANAGED'][lockData.escrowType] || 'Unknown'}</dd></div>
              {lockData.grantManager !== '0x0000000000000000000000000000000000000000' && (
                <div className="ledger-row"><dt>Grant manager</dt><dd className="font-mono text-[13px]">{formatAddress(lockData.grantManager)}</dd></div>
              )}
              <div className="ledger-row"><dt>Auction opened</dt><dd>{formatTime(listingData.startTime)}</dd></div>
              <div className="ledger-row"><dt>Auction closes</dt><dd>{formatTime(listingData.endTime)}</dd></div>
            </dl>
          </section>
        </div>

        {/* ---------------- Right: purchase panel ---------------- */}
        <aside className="lg:sticky lg:top-24" aria-label="Purchase">
          <div className="rounded-2xl p-6" style={{ background: 'linear-gradient(160deg,rgba(38,32,33,.95),rgba(24,27,32,.98))', border: '1px solid rgba(214,168,79,.2)', boxShadow: '0 24px 50px -28px rgba(0,0,0,.8)' }}>
            {purchased ? (
              <div className="reveal text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full" style={{ background: 'rgba(214,168,79,.12)', border: '1px solid rgba(214,168,79,.4)' }}>
                  <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden><path d="M5 11.5l4 4 8-9" fill="none" stroke="#D6A84F" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </div>
                <h2 className="font-display text-2xl font-medium text-white">Lock #{tokenId} is yours</h2>
                <p className="mt-2 text-sm leading-6" style={{ color: '#aeb6c0' }}>The payment and the transfer settled in one transaction.</p>
                <div className="mt-5 space-y-2 text-left text-sm">
                  {approveTx && <a href={explorerTx(approveTx)} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-white/5" style={{ border: '1px solid rgba(137,147,159,.16)', color: '#d58d83' }}>Approval transaction <span aria-hidden>↗</span></a>}
                  {buyTx && <a href={explorerTx(buyTx)} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-white/5" style={{ border: '1px solid rgba(137,147,159,.16)', color: '#d58d83' }}>Purchase transaction <span aria-hidden>↗</span></a>}
                </div>
                <div className="mt-5 flex gap-3">
                  <Link href="/" className="btn-secondary flex-1">Marketplace</Link>
                  <Link href="/sell" className="btn-primary flex-1">Sell or relist</Link>
                </div>
              </div>
            ) : (
              <>
                <h2 className="font-display text-2xl font-medium text-white">
                  {isActive ? 'Buy this lock' : status === 'sold' ? 'Already sold' : status === 'cancelled' ? 'Listing withdrawn' : 'Auction closed'}
                </h2>

                <dl className="mt-5 space-y-3">
                  <div className="ledger-row"><dt>Price now</dt><dd>{formatPrice(currentPrice)} MUSD</dd></div>
                  {feeBps !== null && <div className="ledger-row"><dt><Term tip="Taken from the sale price by the market contract. The buyer pays the listed price.">Marketplace fee</Term></dt><dd>{(Number(feeBps) / 100).toString()}%</dd></div>}
                  {isActive && <div className="ledger-row"><dt><Term tip="The most this purchase can ever cost: today's price plus a 5% buffer. Because the price only falls, you will normally pay today's price or less.">Spending cap</Term></dt><dd>{formatPrice(maxPrice)} MUSD</dd></div>}
                  {address && musdBalance !== null && <div className="ledger-row"><dt>Your MUSD</dt><dd style={{ color: insufficient ? '#e5a79d' : undefined }}>{formatPrice(musdBalance)}</dd></div>}
                </dl>

                {insufficient && isActive && !isOwner && (
                  <p role="status" className="mt-4 rounded-lg px-3 py-2 text-xs leading-5" style={{ color: '#e5b7b0', background: 'rgba(169,68,56,.12)', border: '1px solid rgba(196,90,76,.3)' }}>
                    Your wallet holds less MUSD than the current price. Top up with testnet MUSD before buying.
                  </p>
                )}

                {busy && (
                  <ol className="mt-5 space-y-2.5" aria-live="polite">
                    {steps.map(st => (
                      <li key={st.key} className="flex items-center gap-3 text-sm" style={{ color: st.done ? '#e0bd77' : st.active ? '#fff' : '#89939F' }}>
                        <span className="flex h-5 w-5 items-center justify-center rounded-full text-[11px]" style={{ border: `1px solid ${st.done ? 'rgba(214,168,79,.6)' : st.active ? 'rgba(196,90,76,.9)' : 'rgba(137,147,159,.3)'}` }}>
                          {st.done ? '✓' : st.active ? <span className="h-2 w-2 animate-pulse-dot rounded-full" style={{ background: '#c45a4c' }} /> : ''}
                        </span>
                        {st.label}
                      </li>
                    ))}
                  </ol>
                )}

                <div className="mt-6">
                  {!address ? (
                    <button onClick={connectWallet} className="btn-primary w-full !py-3.5 text-base">Connect wallet to buy</button>
                  ) : !isMezoTestnet ? (
                    <button onClick={switchNetwork} disabled={isSwitching} className="btn-primary w-full !py-3.5 text-base">{isSwitching ? 'Switching…' : 'Switch to Mezo Testnet'}</button>
                  ) : isOwner ? (
                    <div className="rounded-lg px-4 py-3 text-center text-sm" style={{ color: '#aeb6c0', background: 'rgba(137,147,159,.08)', border: '1px solid rgba(137,147,159,.18)' }}>
                      This is your listing. Manage it from <Link href="/sell" className="underline underline-offset-4" style={{ color: '#d58d83' }}>Sell a lock</Link>.
                    </div>
                  ) : isActive ? (
                    <button onClick={handleBuy} disabled={busy} className="btn-primary w-full !py-3.5 text-base">
                      {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden />}
                      {stepLabel[buyStep]}
                    </button>
                  ) : (
                    <div className="rounded-lg px-4 py-3 text-center text-sm" style={{ color: '#89939F', background: 'rgba(137,147,159,.08)', border: '1px solid rgba(137,147,159,.16)' }}>
                      This listing is no longer available.
                    </div>
                  )}
                </div>

                {txError && (
                  <p role="alert" className="mt-4 rounded-lg px-3 py-2.5 text-sm leading-5" style={{ color: '#e5b7b0', background: 'rgba(169,68,56,.12)', border: '1px solid rgba(196,90,76,.32)' }}>
                    {txError}
                  </p>
                )}

                {isActive && !isOwner && address && isMezoTestnet && (
                  <p className="mt-4 text-xs leading-5" style={{ color: '#89939F' }}>
                    Expect up to two wallet prompts: first approve MUSD, then confirm the purchase. Your MUSD only moves when the lock transfers to you.
                  </p>
                )}
              </>
            )}
          </div>
        </aside>
      </div>
    </Shell>
  )
}
