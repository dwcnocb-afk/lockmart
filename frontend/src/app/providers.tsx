'use client'

import { ReactNode, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { config } from '@/lib/wagmi'
import { ChainProvider } from './chain-provider'

export function Providers({ children }: { children: ReactNode }) {
  // Create QueryClient once per session using useState initializer
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
    },
  }))

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={config}>
        <ChainProvider>{children}</ChainProvider>
      </WagmiProvider>
    </QueryClientProvider>
  )
}