'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAccount, useChainId, useDisconnect } from 'wagmi'
import { MEZO_TESTNET_ID, MEZO_TESTNET_NAME } from '@/lib/wagmi'
import { useChainContext } from '@/app/chain-provider'
import { formatAddress } from '@/lib/utils'

export function Nav() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)
  const { disconnectWallet, switchNetwork, connectWallet, isSwitching } = useChainContext()
  const { disconnect } = useDisconnect()
  const isMezoTestnet = chainId === MEZO_TESTNET_ID

  const handleDisconnect = async () => {
    await disconnect()
    await disconnectWallet()
  }

  const links = [
    { href: '/', label: 'Marketplace' },
    { href: '/sell', label: 'Sell a lock' },
    { href: '/proof', label: 'On-chain proof' },
  ]

  return (
    <header className="sticky top-0 z-50 border-b backdrop-blur-xl" style={{ background: 'rgba(21,23,27,.92)', borderColor: 'rgba(137,147,159,.16)' }}>
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-[72px] gap-4">
          <div className="flex items-center gap-9 min-w-0">
            <Link href="/" className="flex items-center gap-3 shrink-0" onClick={() => setMenuOpen(false)}>
              <span className="flex items-center justify-center w-9 h-9 rounded-xl text-white font-black text-lg" style={{ background: 'linear-gradient(145deg,#c45a4c,#8e382f)' }}>L</span>
              <span className="text-lg font-bold tracking-tight text-white">LOCKMART<span className="text-xs align-top ml-1" style={{ color: '#D6A84F' }}>MARKET</span></span>
            </Link>
            <div className="hidden md:flex items-center gap-1">
              {links.map(link => (
                <Link key={link.href} href={link.href} className="px-3 py-2 rounded-lg text-sm transition-colors" style={{ color: pathname === link.href ? '#fff' : '#89939F', background: pathname === link.href ? 'rgba(169,68,56,.16)' : 'transparent' }}>
                  {link.label}
                </Link>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden sm:flex items-center gap-2 rounded-full px-3 py-2 text-xs border" style={{ borderColor: 'rgba(137,147,159,.2)', background: 'rgba(255,255,255,.025)' }}>
              <span className="w-2 h-2 rounded-full" style={{ background: isMezoTestnet ? '#D6A84F' : '#c45a4c', boxShadow: '0 0 10px currentColor' }} />
              <span style={{ color: '#c3cad2' }}>{isMezoTestnet ? MEZO_TESTNET_NAME : 'Wrong network'}</span>
            </div>
            {!isMezoTestnet && isConnected && (
              <button onClick={switchNetwork} disabled={isSwitching} className="btn-secondary hidden sm:inline-flex">
                {isSwitching ? 'Switching…' : 'Switch network'}
              </button>
            )}
            {isConnected ? (
              <div className="flex items-center gap-2">
                <span className="hidden sm:inline-flex rounded-lg px-3 py-2 text-xs font-mono border" style={{ color: '#e6e1da', borderColor: 'rgba(137,147,159,.2)', background: '#20252c' }}>{formatAddress(address!)}</span>
                <button onClick={handleDisconnect} className="btn-secondary !px-3 !py-2">Disconnect</button>
              </div>
            ) : (
              <button onClick={connectWallet} className="btn-primary !px-3 sm:!px-4 !py-2.5">Connect wallet</button>
            )}
            <button aria-label="Toggle navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(v => !v)} className="md:hidden w-10 h-10 rounded-lg border flex items-center justify-center text-white" style={{ borderColor: 'rgba(137,147,159,.24)' }}>
              <span className="text-xl leading-none">{menuOpen ? '×' : '☰'}</span>
            </button>
          </div>
        </div>
        {menuOpen && (
          <div className="md:hidden pb-4 border-t pt-3 flex flex-col gap-1" style={{ borderColor: 'rgba(137,147,159,.16)' }}>
            {links.map(link => (
              <Link key={link.href} href={link.href} onClick={() => setMenuOpen(false)} className="px-3 py-3 rounded-lg text-sm" style={{ color: pathname === link.href ? '#fff' : '#aeb6c0', background: pathname === link.href ? 'rgba(169,68,56,.16)' : 'transparent' }}>{link.label}</Link>
            ))}
            {!isMezoTestnet && isConnected && <button onClick={switchNetwork} className="btn-secondary mt-2">{isSwitching ? 'Switching…' : 'Switch to Mezo Testnet'}</button>}
          </div>
        )}
      </nav>
    </header>
  )
}
