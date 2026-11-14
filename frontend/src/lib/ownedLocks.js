import type { PublicClient } from 'viem'
import { veMEZO_ABI } from './contracts'

type Address = `0x${string}`

/**
 * Finds the veMEZO token IDs owned by `owner`.
 *
 * The deployed veMEZO is Solidly/Velodrome-style but its enumeration getter is not
 * guaranteed to match any one standard, so we try, in order:
 *   1. ownerToNFTokenIdList(owner, i)   (Solidly / Velodrome)
 *   2. tokenOfOwnerByIndex(owner, i)    (ERC-721 Enumerable)
 *   3. Transfer(to = owner) event scan, verified with ownerOf()  (works for any ERC-721)
 * Every candidate is verified with ownerOf() so stale/transferred tokens are dropped.
 */
export async function getOwnedTokenIds(
  client: PublicClient,
  veMEZO: Address,
  owner: Address,
  fromBlock: bigint = 0n,
): Promise<bigint[]> {
  const balance = (await client.readContract({
    address: veMEZO,
    abi: veMEZO_ABI,
    functionName: 'balanceOf',
    args: [owner],
  })) as bigint

  if (balance === 0n) return []

  // Methods 1 & 2: index-based getters
  for (const fn of ['ownerToNFTokenIdList', 'tokenOfOwnerByIndex'] as const) {
    try {
      const ids: bigint[] = []
      for (let i = 0n; i < balance; i++) {
        const id = (await client.readContract({
          address: veMEZO,
          abi: veMEZO_ABI,
          functionName: fn,
          args: [owner, i],
        })) as bigint
        ids.push(id)
      }
      const verified = await verifyOwnership(client, veMEZO, owner, ids)
      if (verified.length > 0) return verified
    } catch (err) {
      console.warn(`[Lockmart] ${fn} failed, trying next method`, err)
    }
  }

  // Method 3: replay Transfer events sent to the owner
  const candidates = await scanTransfersTo(client, veMEZO, owner, fromBlock)
  return verifyOwnership(client, veMEZO, owner, candidates)
}

async function verifyOwnership(
  client: PublicClient,
  veMEZO: Address,
  owner: Address,
  ids: bigint[],
): Promise<bigint[]> {
  const unique = Array.from(new Set(ids.map((i) => i.toString()))).map(BigInt)
  const out: bigint[] = []
  for (const id of unique) {
    try {
      const current = (await client.readContract({
        address: veMEZO,
        abi: veMEZO_ABI,
        functionName: 'ownerOf',
        args: [id],
      })) as string
      if (current.toLowerCase() === owner.toLowerCase()) out.push(id)
    } catch {
      /* burned / invalid id */
    }
  }
  return out
}

async function scanTransfersTo(
  client: PublicClient,
  veMEZO: Address,
  owner: Address,
  fromBlock: bigint,
): Promise<bigint[]> {
  const event = veMEZO_ABI.find((x) => x.type === 'event' && x.name === 'Transfer')!
  const latest = await client.getBlockNumber()

  const getRange = async (from: bigint, to: bigint) =>
    client.getLogs({
      address: veMEZO,
      event: event as any,
      args: { to: owner },
      fromBlock: from,
      toBlock: to,
    })

  let logs: any[] = []
  try {
    // Most RPCs accept one wide query when few logs match
    logs = await getRange(fromBlock, latest)
  } catch {
    // Fall back to chunked scanning, newest first
    const CHUNK = 50_000n
    for (let end = latest; end > fromBlock; end -= CHUNK) {
      const start = end - CHUNK + 1n > fromBlock ? end - CHUNK + 1n : fromBlock
      try {
        logs.push(...(await getRange(start, end)))
      } catch (err) {
        console.warn('[Lockmart] log chunk failed', start, end, err)
      }
    }
  }
  return logs.map((l) => l.args.tokenId as bigint)
}
