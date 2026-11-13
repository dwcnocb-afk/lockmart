'use client'

import { ReactNode, createContext, useContext, useState, useCallback } from 'react'
import { useAccount, useChainId, useSwitchChain, useConnect, useDisconnect } from 'wagmi'
import { MEZO_TESTNET_ID } from '@/lib/wagmi'

interface ChainContextType {
  isWrongNetwork: boolean
  isSwitching: boolean
  switchNetwork: () => Promise<void>
  connectWallet: () => Promise<void>
  disconnectWallet: () => Promise<void>
}

const ChainContext = createContext<ChainContextType | null>(null)

export function ChainProvider({ children }: { children: ReactNode }) {
  const activeChain = useChainId()
  const { address, isConnected } = useAccount()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()

  const [showConnectModal, setShowConnectModal] = useState(false)

  const isWrongNetwork = activeChain !== MEZO_TESTNET_ID

  const switchNetwork = useCallback(async () => {
    try {
      await switchChain({ chainId: MEZO_TESTNET_ID })
    } catch (error) {
      console.error('Failed to switch network:', error)
    }
  }, [switchChain])

  const connectWallet = useCallback(async () => {
    if (connectors.length > 0) {
      await connect({ connector: connectors[0] })
    }
  }, [connect, connectors])

  const disconnectWallet = useCallback(async () => {
    await disconnect()
  }, [disconnect])

  return (
    <ChainContext.Provider
      value={{
        isWrongNetwork,
        isSwitching,
        switchNetwork,
        connectWallet,
        disconnectWallet,
      }}
    >
      {children}
    </ChainContext.Provider>
  )
}

export function useChainContext() {
  const context = useContext(ChainContext)
  if (!context) {
    throw new Error('useChainContext must be used within a ChainProvider')
  }
  return context
}