'use client'

import Link from 'next/link'
import { useAccount, useChainId, useDisconnect } from 'wagmi'
import { MEZO_TESTNET_ID, MEZO_TESTNET_NAME } from '@/lib/wagmi'
import { useChainContext } from '@/app/chain-provider'
import { formatAddress } from '@/lib/utils'

export function Nav() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { disconnectWallet, switchNetwork, isWrongNetwork, connectWallet, isSwitching } = useChainContext()
  const { disconnect } = useDisconnect()

  const isMezoTestnet = chainId === MEZO_TESTNET_ID

  const handleDisconnect = async () => {
    await disconnect()
    await disconnectWallet()
  }

  return (
    <nav className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center">
            <Link href="/" className="text-xl font-bold text-primary-600 dark:text-primary-400">
              Lockmart
            </Link>
            <div className="hidden md:ml-8 md:flex md:space-x-4">
              <Link
                href="/"
                className="px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:text-primary-600 dark:text-gray-300 dark:hover:text-primary-400"
              >
                Browse
              </Link>
              <Link
                href="/sell"
                className="px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:text-primary-600 dark:text-gray-300 dark:hover:text-primary-400"
              >
                Sell
              </Link>
              <Link
                href="/proof"
                className="px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:text-primary-600 dark:text-gray-300 dark:hover:text-primary-400"
              >
                Proof
              </Link>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            {/* Network indicator */}
            <div className="flex items-center space-x-2">
              <span
                className={`px-2 py-1 text-xs font-medium rounded-full ${
                  isMezoTestnet
                    ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                    : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
                }`}
              >
                {isMezoTestnet ? MEZO_TESTNET_NAME : 'Wrong Network'}
              </span>
              {!isMezoTestnet && !isSwitching && (
                <button
                  onClick={switchNetwork}
                  className="btn-secondary text-sm"
                  disabled={isSwitching}
                >
                  Switch Network
                </button>
              )}
            </div>

            {/* Wallet connection */}
            {isConnected ? (
              <div className="flex items-center space-x-3">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {formatAddress(address!)}
                </span>
                <button onClick={handleDisconnect} className="btn-secondary text-sm">
                  Disconnect
                </button>
              </div>
            ) : (
              <button onClick={connectWallet} className="btn-primary text-sm">
                Connect Wallet
              </button>
            )}
          </div>
        </div>
      </div>
    </nav>
  )
}