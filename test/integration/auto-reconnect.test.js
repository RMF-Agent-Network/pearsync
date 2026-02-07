/**
 * Auto-Reconnect Test
 * 
 * P0-4: Verify that sync continues gracefully after network interruption
 */

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { setTimeout as sleep } from 'timers/promises'
import { SyncEngine } from '../../lib/sync-v2.js'

const TEST_DIR = path.join(os.tmpdir(), `pearsync-reconnect-${Date.now()}`)

function suppressErrors(engine) {
  engine.on('error', () => {})
}

function logEvents(engine, name) {
  engine.on('status', msg => console.log(`[${name}] ${msg}`))
  engine.on('peer-join', ({ peerId, total }) => console.log(`[${name}] Peer joined: ${peerId} (${total})`))
  engine.on('peer-leave', ({ peerId, total }) => console.log(`[${name}] Peer left: ${peerId} (${total})`))
}

async function createTestDir(name) {
  const dir = path.join(TEST_DIR, name)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function cleanup() {
  await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
}

async function waitForConnection(engineA, engineB, timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (engineA.peerCount > 0 && engineB.peerCount > 0) {
      return true
    }
    await sleep(500)
  }
  return false
}

async function waitForWritable(engine, timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await engine.autobase.base.update()
    if (engine.autobase.base.writable) {
      return true
    }
    await sleep(500)
  }
  return false
}

test('auto-reconnect: sync resumes after network interruption', async (t) => {
  const peerALocal = await createTestDir('reconnect-peerA-local')
  const peerAStorage = await createTestDir('reconnect-peerA-storage')
  const peerBLocal = await createTestDir('reconnect-peerB-local')
  const peerBStorage = await createTestDir('reconnect-peerB-storage')

  // Create peer A
  const peerA = new SyncEngine({
    localPath: peerALocal,
    storagePath: peerAStorage
  })
  suppressErrors(peerA)
  logEvents(peerA, 'A')

  const key = await peerA.init()
  t.ok(key, 'peer A initialized')

  // Create initial file on A
  await fs.writeFile(path.join(peerALocal, 'before-disconnect.txt'), 'Created before disconnect')
  await peerA.syncToRemote()
  console.log('[TEST] Initial file synced by A')

  // Create peer B
  const peerB = new SyncEngine({
    localPath: peerBLocal,
    storagePath: peerBStorage,
    remoteKey: key
  })
  suppressErrors(peerB)
  logEvents(peerB, 'B')

  await peerB.init()
  t.ok(peerB.ready, 'peer B initialized')

  // Wait for connection
  const connected = await waitForConnection(peerA, peerB)
  t.ok(connected, 'peers connected initially')

  // Wait for B to become writable
  const bWritable = await waitForWritable(peerB)
  t.ok(bWritable, 'peer B became writable')

  // B syncs the initial file
  await peerB.syncToLocal()
  const beforeContent = await fs.readFile(path.join(peerBLocal, 'before-disconnect.txt'), 'utf-8')
  t.is(beforeContent, 'Created before disconnect', 'B received file before disconnect')

  console.log('[TEST] === SIMULATING NETWORK DISCONNECT ===')

  // Store the topic for rejoining
  const topic = peerA.autobase.base.discoveryKey
  
  // Simulate network disconnect by destroying all connections
  // This is more realistic than just leaving the topic
  const peerACountBefore = peerA.peerCount
  const peerBCountBefore = peerB.peerCount
  console.log(`[TEST] Before disconnect: A peers=${peerACountBefore}, B peers=${peerBCountBefore}`)
  
  // Destroy and recreate swarms to simulate network failure
  await peerA.swarm.destroy()
  await peerB.swarm.destroy()
  
  // Create new swarms
  const Hyperswarm = (await import('hyperswarm')).default
  peerA.swarm = new Hyperswarm()
  peerB.swarm = new Hyperswarm()
  
  // Set up connection handlers again
  peerA.swarm.on('connection', (socket, info) => {
    peerA.peerCount++
    peerA.store.replicate(socket)
    peerA._exchangeWriterKeys(socket, info)
    socket.on('close', () => peerA.peerCount--)
  })
  
  peerB.swarm.on('connection', (socket, info) => {
    peerB.peerCount++
    peerB.store.replicate(socket)
    peerB._exchangeWriterKeys(socket, info)
    socket.on('close', () => peerB.peerCount--)
  })
  
  // Reset peer counts
  peerA.peerCount = 0
  peerB.peerCount = 0
  
  await sleep(1000)
  
  console.log(`[TEST] After disconnect: A peers=${peerA.peerCount}, B peers=${peerB.peerCount}`)
  t.is(peerA.peerCount, 0, 'A has no peers after disconnect')
  t.is(peerB.peerCount, 0, 'B has no peers after disconnect')

  // A creates a file while disconnected
  await fs.writeFile(path.join(peerALocal, 'during-disconnect.txt'), 'Created during disconnect')
  await peerA.syncToRemote()
  console.log('[TEST] A created file during disconnect')

  console.log('[TEST] === SIMULATING RECONNECT ===')

  // Rejoin swarm with new swarm instances
  const discoveryA = peerA.swarm.join(topic, { server: true, client: true })
  const discoveryB = peerB.swarm.join(topic, { server: true, client: true })
  await discoveryA.flushed()
  await discoveryB.flushed()

  // Wait for reconnection
  const reconnected = await waitForConnection(peerA, peerB)
  t.ok(reconnected, 'peers reconnected')

  console.log(`[TEST] After reconnect: A peers=${peerA.peerCount}, B peers=${peerB.peerCount}`)

  // Wait for replication to settle
  await sleep(3000)
  await peerB.autobase.base.update()

  // B syncs and should get the file created during disconnect
  await peerB.syncToLocal()

  // Verify B has both files
  const beforeExists = await fs.access(path.join(peerBLocal, 'before-disconnect.txt')).then(() => true).catch(() => false)
  const duringExists = await fs.access(path.join(peerBLocal, 'during-disconnect.txt')).then(() => true).catch(() => false)
  
  t.ok(beforeExists, 'B still has file from before disconnect')
  t.ok(duringExists, 'B received file created during disconnect')

  if (duringExists) {
    const duringContent = await fs.readFile(path.join(peerBLocal, 'during-disconnect.txt'), 'utf-8')
    t.is(duringContent, 'Created during disconnect', 'file content is correct')
  }

  await peerA.close()
  await peerB.close()
})

test('auto-reconnect: handles rapid disconnect/reconnect cycles', async (t) => {
  const peerALocal = await createTestDir('rapid-peerA-local')
  const peerAStorage = await createTestDir('rapid-peerA-storage')
  const peerBLocal = await createTestDir('rapid-peerB-local')
  const peerBStorage = await createTestDir('rapid-peerB-storage')

  const peerA = new SyncEngine({
    localPath: peerALocal,
    storagePath: peerAStorage
  })
  suppressErrors(peerA)

  const key = await peerA.init()
  
  const peerB = new SyncEngine({
    localPath: peerBLocal,
    storagePath: peerBStorage,
    remoteKey: key
  })
  suppressErrors(peerB)

  await peerB.init()
  
  // Wait for initial connection
  await waitForConnection(peerA, peerB)
  await waitForWritable(peerB)
  
  const topic = peerA.autobase.base.discoveryKey
  
  // Rapid disconnect/reconnect cycles
  for (let i = 0; i < 3; i++) {
    console.log(`[TEST] Cycle ${i + 1}: disconnecting...`)
    await peerA.swarm.leave(topic)
    await peerB.swarm.leave(topic)
    await sleep(500)
    
    console.log(`[TEST] Cycle ${i + 1}: reconnecting...`)
    await peerA.swarm.join(topic, { server: true, client: true }).flushed()
    await peerB.swarm.join(topic, { server: true, client: true }).flushed()
    await sleep(1000)
  }
  
  // After rapid cycles, verify sync still works
  await fs.writeFile(path.join(peerALocal, 'after-cycles.txt'), 'After rapid cycles')
  await peerA.syncToRemote()
  
  // Wait for connection and replication
  await waitForConnection(peerA, peerB)
  await sleep(3000)
  await peerB.autobase.base.update()
  await peerB.syncToLocal()
  
  const fileExists = await fs.access(path.join(peerBLocal, 'after-cycles.txt')).then(() => true).catch(() => false)
  t.ok(fileExists, 'sync works after rapid disconnect/reconnect cycles')
  
  await peerA.close()
  await peerB.close()
})

test('cleanup', async (t) => {
  await cleanup()
  t.pass('cleaned up')
})
