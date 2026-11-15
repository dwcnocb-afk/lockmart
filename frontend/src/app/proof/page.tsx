'use client'

import { Nav } from '@/components/Nav'
import { CopyButton } from '@/components/ui'
import { getAddresses } from '@/lib/contracts'
import { MEZO_TESTNET_ID, MEZO_TESTNET_EXPLORER } from '@/lib/wagmi'

// Demo transaction hashes - replace with actual values
const DEMO_TRANSACTIONS = [
  {
    hash: '0x8cc972173e51c3070b3f0c6e0447fb450a3a6299ebc70499c4a9a999b6731943',
    description: 'LockMarket deployment (block 16744271)',
    type: 'deployment',
  },
  {
    hash: '0xa062d406eac60d46bf7cca6d8fc7f80c685030e5e07969ed6dbf1fa8b4dd52ef',
    description: 'LockMarket deployment (block 16724578) - DEFAULT',
    type: 'deployment',
  },
  // Add your demo transaction hashes here:
  // {
  //   hash: '0x...',
  //   description: 'Buy lock #123',
  //   type: 'buy',
  // },
  // {
  //   hash: '0x...',
  //   description: 'List lock #456',
  //   type: 'list',
  // },
]


const TYPE_STYLE: Record<string, { color: string; bg: string; border: string }> = {
  deployment: { color: '#aeb6c0', bg: 'rgba(137,147,159,.1)', border: 'rgba(137,147,159,.28)' },
  buy: { color: '#e0bd77', bg: 'rgba(214,168,79,.1)', border: 'rgba(214,168,79,.3)' },
  list: { color: '#e5a79d', bg: 'rgba(169,68,56,.14)', border: 'rgba(196,90,76,.35)' },
  cancel: { color: '#89939f', bg: 'rgba(137,147,159,.08)', border: 'rgba(137,147,159,.2)' },
}

export default function ProofPage() {
  const addresses = getAddresses(MEZO_TESTNET_ID)
  const contracts = [
    { name: 'LockMarket', note: 'The marketplace contract that escrows nothing and settles every sale.', address: addresses.LockMarket },
    { name: 'veMEZO', note: 'The voting-escrow NFT being traded.', address: addresses.veMEZO },
    { name: 'MUSD', note: 'The settlement token.', address: addresses.MUSD },
  ]

  return (
    <div className="min-h-screen">
      <Nav />
      <main id="main" className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
        <header className="reveal mb-12 max-w-2xl">
          <p className="eyebrow mb-3">Transparency · Mezo Explorer</p>
          <h1 className="font-display text-4xl font-medium tracking-tight text-white sm:text-5xl">Don&apos;t take our word for it</h1>
          <p className="mt-4 text-base leading-7" style={{ color: '#aeb6c0' }}>
            Everything Lockmart does happens on Mezo Testnet. These are the contracts it talks to and the transactions that prove it works. Open any of them and read the record yourself.
          </p>
        </header>

        <section aria-labelledby="contracts" className="mb-14">
          <h2 id="contracts" className="font-display text-2xl font-medium text-white">Contracts</h2>
          <div className="mt-5 grid gap-4 md:grid-cols-3">
            {contracts.map((c, i) => (
              <div key={c.name} className="reveal rounded-2xl p-5" style={{ animationDelay: `${i * 70}ms`, background: 'rgba(27,31,37,.7)', border: '1px solid rgba(137,147,159,.16)' }}>
                <p className="eyebrow mb-2">{c.name}</p>
                <p className="min-h-[44px] text-sm leading-6" style={{ color: '#89939F' }}>{c.note}</p>
                <p className="mt-4 break-all font-mono text-xs" style={{ color: '#d8dde3' }}>{c.address}</p>
                <div className="mt-4 flex items-center gap-2">
                  <CopyButton value={c.address} label="Copy address" />
                  <a href={`${MEZO_TESTNET_EXPLORER}/address/${c.address}`} target="_blank" rel="noopener noreferrer" className="rounded-md px-2 py-1 text-[11px] font-medium transition-colors hover:text-white" style={{ color: '#d58d83', border: '1px solid rgba(196,90,76,.3)' }}>
                    View on explorer ↗
                  </a>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="txs">
          <h2 id="txs" className="font-display text-2xl font-medium text-white">Transactions</h2>
          {DEMO_TRANSACTIONS.length === 0 ? (
            <div className="mt-5 rounded-2xl p-10 text-center" style={{ background: 'rgba(27,31,37,.55)', border: '1px dashed rgba(137,147,159,.3)' }}>
              <p className="font-display text-xl text-white">No transactions published yet</p>
              <p className="mt-2 text-sm" style={{ color: '#89939F' }}>Deployments, listings and purchases will be linked here as they happen.</p>
            </div>
          ) : (
            <ul className="mt-5 divide-y rounded-2xl" style={{ background: 'rgba(27,31,37,.7)', border: '1px solid rgba(137,147,159,.16)', borderColor: 'rgba(137,147,159,.16)' }}>
              {DEMO_TRANSACTIONS.map((tx, index) => {
                const isDefault = /\s*-\s*DEFAULT$/.test(tx.description)
                const description = tx.description.replace(/\s*-\s*DEFAULT$/, '')
                const style = TYPE_STYLE[tx.type] ?? TYPE_STYLE.deployment
                return (
                  <li key={tx.hash + index} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: 'rgba(137,147,159,.12)' }}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: style.color, background: style.bg, border: `1px solid ${style.border}` }}>{tx.type}</span>
                        {isDefault && <span className="rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: '#e0bd77', background: 'rgba(214,168,79,.1)', border: '1px solid rgba(214,168,79,.3)' }}>In use by this app</span>}
                        <span className="text-sm font-medium text-white">{description}</span>
                      </div>
                      <p className="mt-2 truncate font-mono text-xs" style={{ color: '#89939F' }} title={tx.hash}>{tx.hash}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <CopyButton value={tx.hash} label="Copy hash" />
                      <a href={`${MEZO_TESTNET_EXPLORER}/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer" className="btn-secondary !py-1.5 !text-xs" style={{ color: '#d58d83' }}>
                        View on explorer ↗
                      </a>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  )
}
