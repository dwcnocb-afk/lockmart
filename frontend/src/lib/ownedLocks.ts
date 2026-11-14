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

// ---------- Lock details (tolerant reader) ----------

const LOCKED_3 = [{ inputs: [{ name: 'tokenId', type: 'uint256' }], name: 'locked', outputs: [{ name: 'amount', type: 'int128' }, { name: 'end', type: 'uint256' }, { name: 'isPermanent', type: 'bool' }], stateMutability: 'view', type: 'function' }] as const
const LOCKED_2 = [{ inputs: [{ name: 'tokenId', type: 'uint256' }], name: 'locked', outputs: [{ name: 'amount', type: 'int128' }, { name: 'end', type: 'uint256' }], stateMutability: 'view', type: 'function' }] as const

export interface LockDetails {
  amount: bigint
  end: bigint
  isPermanent: boolean
  votingPower: bigint
  voted: boolean
  escrowType: number
  grantManager: string
  currentPrice: bigint
  listingActive: boolean
  failedFields: string[]
}

/**
 * Reads a lock's details. Tries LockMarket.inspect() first; if that reverts, reads each
 * field straight from veMEZO so one mismatching getter can't hide the whole lock.
 * Fields that can't be read are listed in `failedFields` and logged to the console.
 */
export async function readLockDetails(
  client: PublicClient,
  veMEZO: Address,
  lockMarket: Address,
  lockMarketAbi: any,
  tokenId: bigint,
): Promise<LockDetails> {
  try {
    const r = (await client.readContract({
      address: lockMarket, abi: lockMarketAbi, functionName: 'inspect', args: [tokenId],
    })) as readonly [bigint, bigint, boolean, bigint, boolean, number, string, bigint, boolean]
    return {
      amount: r[0], end: r[1], isPermanent: r[2], votingPower: r[3], voted: r[4],
      escrowType: Number(r[5]), grantManager: r[6], currentPrice: r[7], listingActive: r[8],
      failedFields: [],
    }
  } catch (err) {
    console.warn(`[Lockmart] inspect(${tokenId}) reverted, reading veMEZO directly`, err)
  }

  const failed: string[] = []
  const tryRead = async <T,>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn() } catch (err) {
      failed.push(name)
      console.warn(`[Lockmart] veMEZO.${name}(${tokenId}) failed`, err)
      return fallback
    }
  }
  const read = (fnName: string, abi: any) =>
    client.readContract({ address: veMEZO, abi, functionName: fnName, args: [tokenId] } as any)

  let amount = 0n, end = 0n, isPermanent = false, lockedOk = true
  try {
    const l = (await read('locked', LOCKED_3)) as readonly [bigint, bigint, boolean]
    amount = BigInt(l[0]); end = l[1]; isPermanent = l[2]
  } catch {
    try {
      const l = (await read('locked', LOCKED_2)) as readonly [bigint, bigint]
      amount = BigInt(l[0]); end = l[1]
      console.warn('[Lockmart] veMEZO.locked returns 2 values (no isPermanent) — LockMarket.sol expects 3')
      failed.push('locked(3-value)')
    } catch (err) {
      lockedOk = false
      failed.push('locked')
      console.warn(`[Lockmart] veMEZO.locked(${tokenId}) failed`, err)
    }
  }
  if (!lockedOk) throw new Error(`Could not read lock #${tokenId}`)

  const votingPower = await tryRead('votingPowerOfNFT', () => read('votingPowerOfNFT', veMEZO_ABI) as Promise<bigint>, 0n)
  const voted = await tryRead('voted', () => read('voted', veMEZO_ABI) as Promise<boolean>, false)
  const escrowType = await tryRead('escrowType', async () => Number(await read('escrowType', veMEZO_ABI)), 0)
  const grantManager = await tryRead('grantManager', () => read('grantManager', veMEZO_ABI) as Promise<string>, '0x0000000000000000000000000000000000000000')

  return { amount, end, isPermanent, votingPower, voted, escrowType, grantManager, currentPrice: 0n, listingActive: false, failedFields: failed }
}
