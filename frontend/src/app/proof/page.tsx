'use client'

import { Nav } from '@/components/Nav'

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

export default function ProofPage() {
  return (
    <div className="min-h-screen">
      <Nav />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <p className="eyebrow mb-3">Transparency / Mezo Explorer</p>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-white">On-chain proof</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6" style={{ color: '#89939F' }}>
            Inspect the contract activity and verify transaction records directly on the Mezo Testnet explorer.
          </p>
        </div>

        <div className="card">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-sm text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <th className="pb-3 font-medium">Transaction Hash</th>
                  <th className="pb-3 font-medium">Description</th>
                  <th className="pb-3 font-medium">Type</th>
                  <th className="pb-3 font-medium">Explorer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {DEMO_TRANSACTIONS.map((tx, index) => (
                  <tr key={index} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="py-4 font-mono text-sm">
                      <span className="truncate block max-w-xs" title={tx.hash}>
                        {tx.hash}
                      </span>
                    </td>
                    <td className="py-4 text-gray-900 dark:text-white">
                      {tx.description}
                    </td>
                    <td className="py-4">
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                        tx.type === 'deployment' ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200' :
                        tx.type === 'buy' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' :
                        tx.type === 'list' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' :
                        tx.type === 'cancel' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200' :
                        'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                      }`}>
                        {tx.type}
                      </span>
                    </td>
                    <td className="py-4">
                      <a
                        href={`https://explorer.test.mezo.org/tx/${tx.hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline text-sm font-semibold" style={{ color: "#d58d83" }}
                      >
                        View on Explorer
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {DEMO_TRANSACTIONS.length === 0 && (
            <div className="text-center py-12">
              <div className="text-gray-500 dark:text-gray-400 text-lg">No demo transactions configured</div>
              <p className="mt-2 text-gray-400 dark:text-gray-500">
                Add transaction hashes to the DEMO_TRANSACTIONS array in <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">src/app/proof/page.tsx</code>
              </p>
            </div>
          )}
        </div>

      </main>
    </div>
  )
}