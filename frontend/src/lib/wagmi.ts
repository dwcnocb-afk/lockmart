import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import type { Chain } from 'viem'

// Mezo Testnet (Matsnet) - Chain ID 31611
export const mezoTestnet: Chain = {
  id: 31611,
  name: 'Mezo Testnet (Matsnet)',
  nativeCurrency: {
    decimals: 18,
    name: 'BTC',
    symbol: 'BTC',
  },
  rpcUrls: {
    default: { http: ['https://rpc.test.mezo.org'] },
  },
  blockExplorers: {
    default: { name: 'Mezo Explorer', url: 'https://explorer.test.mezo.org' },
  },
  testnet: true,
}

// Simple exports for client components
export const MEZO_TESTNET_ID = 31611
export const MEZO_TESTNET_NAME = 'Mezo Testnet (Matsnet)'
export const MEZO_TESTNET_RPC = 'https://rpc.test.mezo.org'
export const MEZO_TESTNET_EXPLORER = 'https://explorer.test.mezo.org'

// Get WalletConnect project ID from env
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || ''

// Only use WalletConnect if project ID is configured
const connectors = [
  injected({ shimDisconnect: true }),
  // Add WalletConnect when project ID is available
  // ...(projectId ? [walletConnect({ projectId, showQrModal: true })] : []),
] as const

// Create config at module level with ssr: true
export const config = createConfig({
  chains: [mezoTestnet],
  connectors,
  transports: {
    [mezoTestnet.id]: http(),
  },
  ssr: true,
})

export type Config = typeof config