'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAccount, useChainId, useDisconnect } from 'wagmi'
import { MEZO_TESTNET_ID, MEZO_TESTNET_NAME } from '@/lib/wagmi'
import { useChainContext } from '@/app/chain-provider'
import { formatAddress } from '@/lib/utils'
import { CopyButton, LockmartMark } from '@/components/ui'

export function Nav() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const { disconnectWallet, switchNetwork, connectWallet, isSwitching } = useChainContext()
  const { disconnect } = useDisconnect()
  const isMezoTestnet = chainId === MEZO_TESTNET_ID

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const handleDisconnect = async () => {
    await disconnect()
    await disconnectWallet()
  }

  const links = [
    { href: '/', label: 'Marketplace' },
    { href: '/sell', label: 'Sell a lock' },
    { href: '/proof', label: 'On-chain proof' },
  ]
  const isActive = (href: string) => (href === '/' ? pathname === '/' || pathname.startsWith('/lock') : pathname === href)

  return (
    <header
      className="sticky top-0 z-50 transition-all duration-300"
      style={{
        background: scrolled ? 'rgba(16,18,21,.88)' : 'rgba(21,23,27,.6)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        borderBottom: `1px solid ${scrolled ? 'rgba(137,147,159,.2)' : 'rgba(137,147,159,.08)'}`,
      }}
    >
      <nav className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8" aria-label="Primary">
        <div className="flex h-[68px] items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-10">
            <Link href="/" className="group flex shrink-0 items-center gap-3" onClick={() => setMenuOpen(false)} aria-label="Lockmart home">
              <span className="transition-transform duration-300 group-hover:-rotate-3"><LockmartMark /></span>
              <span className="font-display text-[22px] font-medium leading-none tracking-tight text-white">
                Lockmart
              </span>
            </Link>
            <div className="hidden items-center gap-1 md:flex">
              {links.map(link => {
                const active = isActive(link.href)
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    className="relative rounded-md px-3 py-2 text-sm transition-colors duration-200 hover:text-white"
                    style={{ color: active ? '#fff' : '#89939F' }}
                  >
                    {link.label}
                    <span
                      className="absolute inset-x-3 -bottom-[13px] h-[2px] origin-left rounded-full transition-transform duration-300"
                      style={{ background: 'linear-gradient(90deg,#c45a4c,#d6a84f)', transform: active ? 'scaleX(1)' : 'scaleX(0)' }}
                    />
                  </Link>
                )
              })}
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <div
              className="hidden items-center gap-2 rounded-full px-3 py-1.5 text-xs sm:flex"
              style={{ border: '1px solid rgba(137,147,159,.2)', background: 'rgba(255,255,255,.02)' }}
              title={isMezoTestnet ? 'Connected to the correct network' : 'Your wallet is on a different network'}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${isMezoTestnet ? 'animate-pulse-dot' : ''}`}
                style={{ background: isMezoTestnet ? '#D6A84F' : '#c45a4c' }}
              />
              <span style={{ color: '#c3cad2' }}>{isMezoTestnet ? MEZO_TESTNET_NAME : 'Wrong network'}</span>
            </div>
            {!isMezoTestnet && isConnected && (
              <button onClick={switchNetwork} disabled={isSwitching} className="btn-secondary hidden sm:inline-flex !py-2">
                {isSwitching ? 'Switching…' : 'Switch network'}
              </button>
            )}
            {isConnected ? (
              <div className="flex items-center gap-2">
                <span
                  className="hidden items-center gap-2 rounded-lg py-1 pl-3 pr-1 text-xs sm:inline-flex"
                  style={{ color: '#e6e1da', border: '1px solid rgba(137,147,159,.2)', background: '#1b1f25' }}
                >
                  <span className="font-mono">{formatAddress(address!)}</span>
                  <CopyButton value={address!} />
                </span>
                <button onClick={handleDisconnect} className="btn-secondary !px-3 !py-2">Disconnect</button>
              </div>
            ) : (
              <button onClick={connectWallet} className="btn-primary !px-4 !py-2">Connect wallet</button>
            )}
            <button
              aria-label="Toggle navigation"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(v => !v)}
              className="flex h-10 w-10 items-center justify-center rounded-lg text-white md:hidden"
              style={{ border: '1px solid rgba(137,147,159,.24)' }}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                <path d={menuOpen ? 'M4 4l10 10M14 4L4 14' : 'M3 5h12M3 9h12M3 13h12'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
              </svg>
            </button>
          </div>
        </div>
        {menuOpen && (
          <div className="flex flex-col gap-1 border-t pb-4 pt-3 md:hidden reveal" style={{ borderColor: 'rgba(137,147,159,.16)' }}>
            {links.map(link => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className="rounded-lg px-3 py-3 text-sm"
                style={{ color: isActive(link.href) ? '#fff' : '#aeb6c0', background: isActive(link.href) ? 'rgba(169,68,56,.16)' : 'transparent' }}
              >
                {link.label}
              </Link>
            ))}
            {!isMezoTestnet && isConnected && (
              <button onClick={switchNetwork} className="btn-secondary mt-2">{isSwitching ? 'Switching…' : 'Switch to Mezo Testnet'}</button>
            )}
          </div>
        )}
      </nav>
    </header>
  )
}
