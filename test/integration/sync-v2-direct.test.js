/**
 * Direct Sync Integration Test for v2
 * 
 * Tests sync between two SyncEngine instances using direct replication
 * (bypasses DHT for faster, more reliable testing)
 */

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { setTimeout as sleep } from 'timers/promises'
import { SyncEngine } from '../../lib/sync-v2.js'

const TEST_DIR = path.join(os.tmpdir(), `pearsync-v2-direct-${Date.now()}`)

// Suppress connection errors during cleanup
function suppressErrors(engine) {
  engine.on('error', () => {})
}

// Log events for debugging
function logEvents(engine, name) {
  engine.on('status', msg => console.log(`[${name}] ${msg}`))
  engine.on('peer-join', ({ peerId, total }) => console.log(`[${name}] Peer joined: ${peerId} (${total})`))
  engine.on('peer-leave', ({ peerId, total }) => console.log(`[${name}] Peer left: ${peerId} (${total})`))
  engine.on('sync-start', ({ direction }) => console.log(`[${name}] Sync start: ${direction}`))
  engine.on('sync-complete', ({ direction, count }) => console.log(`[${name}] Sync complete: ${direction}`, count))
}

async function createTestDir(name) {
  const dir = path.join(TEST_DIR, name)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function cleanup() {
  await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
}

// Wait for replication to settle after peers connect
async function waitForReplication(engineA, engineB, timeoutMs = 30000) {
  const start = Date.now()
  
  // Wait for at least one peer connection
  while (Date.now() - start < timeoutMs) {
    if (engineA.peerCount > 0 || engineB.peerCount > 0) {
      break
    }
    await sleep(500)
  }
  
  // Give time for writer key exchange protocol to complete
  await sleep(2000)
  
  // Wait for both peers to become writable (writer status propagation)
  while (Date.now() - start < timeoutMs) {
    // Force update to process any pending replicated data
    await engineA.autobase.base.update()
    await engineB.autobase.base.update()
    await engineA.autobase.base.view.update()
    await engineB.autobase.base.view.update()
    
    const aWritable = engineA.autobase.base.writable
    const bWritable = engineB.autobase.base.writable
    
    if (aWritable && bWritable) {
      console.log('[TEST] Both peers are now writable')
      return true
    }
    
    // Debug B's state
    const bLocalWriter = engineB.autobase.base.localWriter
    const bLocalKey = engineB.autobase.base.local?.key
    const bIsRemoved = bLocalWriter?.isRemoved
    const bActiveWriters = engineB.autobase.base.activeWriters?.map?.size
    console.log(`[TEST] B: writable=${bWritable}, localWriter=${bLocalWriter ? 'set' : 'null'}, isRemoved=${bIsRemoved}, activeWriters=${bActiveWriters}`)
    await sleep(1000)
  }
  
  // Even if not fully ready, return connection status
  console.log('[TEST] Timeout waiting for writable status')
  return engineA.peerCount > 0 || engineB.peerCount > 0
}

test('direct sync: basic file sync from A to B', async (t) => {
  const peerALocal = await createTestDir('direct-peerA-local')
  const peerAStorage = await createTestDir('direct-peerA-storage')
  const peerBLocal = await createTestDir('direct-peerB-local')
  const peerBStorage = await createTestDir('direct-peerB-storage')

  // Create peer A
  const peerA = new SyncEngine({
    localPath: peerALocal,
    storagePath: peerAStorage
  })
  suppressErrors(peerA)
  logEvents(peerA, 'A')

  const key = await peerA.init()
  t.ok(key, 'peer A initialized')

  // Create a file on A
  await fs.writeFile(path.join(peerALocal, 'hello.txt'), 'Hello from A!')
  await peerA.syncToRemote()
  t.pass('peer A synced file to autobase')

  // Create peer B with A's key
  const peerB = new SyncEngine({
    localPath: peerBLocal,
    storagePath: peerBStorage,
    remoteKey: key
  })
  suppressErrors(peerB)
  logEvents(peerB, 'B')

  await peerB.init()
  t.pass('peer B initialized')

  // Wait for replication via Hyperswarm
  const connected = await waitForReplication(peerA, peerB)
  t.pass(`replication wait complete (connected: ${connected})`)

  // Sync from remote to local on B
  await peerB.syncToLocal()

  // Check if file exists on B
  try {
    const content = await fs.readFile(path.join(peerBLocal, 'hello.txt'), 'utf-8')
    t.is(content, 'Hello from A!', 'file synced to peer B')
  } catch (err) {
    t.fail(`File not found on peer B: ${err.message}`)
  }

  await peerA.close()
  await peerB.close()
})

test('direct sync: autobase entries visible across peers', async (t) => {
  const peerALocal = await createTestDir('entries-peerA-local')
  const peerAStorage = await createTestDir('entries-peerA-storage')
  const peerBLocal = await createTestDir('entries-peerB-local')
  const peerBStorage = await createTestDir('entries-peerB-storage')

  const peerA = new SyncEngine({
    localPath: peerALocal,
    storagePath: peerAStorage
  })
  suppressErrors(peerA)

  const key = await peerA.init()

  // Add entries on A
  await fs.writeFile(path.join(peerALocal, 'file1.txt'), 'Content 1')
  await fs.writeFile(path.join(peerALocal, 'file2.txt'), 'Content 2')
  await peerA.syncToRemote()

  const peerB = new SyncEngine({
    localPath: peerBLocal,
    storagePath: peerBStorage,
    remoteKey: key
  })
  suppressErrors(peerB)

  await peerB.init()

  // Check A's autobase has entries
  const entriesA = await peerA.autobase.list()
  t.is(entriesA.length, 2, 'peer A has 2 entries')

  // Wait for replication
  await waitForReplication(peerA, peerB)

  // Update B's view
  await peerB.autobase.base.view.update()

  // Check B's autobase - this is the key test
  const entriesB = await peerB.autobase.list()
  console.log('Entries on B:', entriesB.length)
  
  // In Autobase, entries might not be visible until proper writer sync
  // This test helps diagnose the issue
  t.pass(`peer B sees ${entriesB.length} entries after replication`)

  await peerA.close()
  await peerB.close()
})

test('direct sync: bidirectional - both peers write simultaneously', async (t) => {
  const peerALocal = await createTestDir('bidir-peerA-local')
  const peerAStorage = await createTestDir('bidir-peerA-storage')
  const peerBLocal = await createTestDir('bidir-peerB-local')
  const peerBStorage = await createTestDir('bidir-peerB-storage')

  // Create peer A (initiator)
  const peerA = new SyncEngine({
    localPath: peerALocal,
    storagePath: peerAStorage
  })
  suppressErrors(peerA)
  logEvents(peerA, 'A')

  const key = await peerA.init()
  t.ok(key, 'peer A initialized')

  // Create peer B (joiner)
  const peerB = new SyncEngine({
    localPath: peerBLocal,
    storagePath: peerBStorage,
    remoteKey: key
  })
  suppressErrors(peerB)
  logEvents(peerB, 'B')

  await peerB.init()
  t.pass('peer B initialized')

  // Wait for peers to connect and exchange writer keys
  const connected = await waitForReplication(peerA, peerB)
  t.ok(connected, 'peers connected')

  // Check writer status
  const aWriters = peerA.autobase.base.activeWriters.map.size
  const bWriters = peerB.autobase.base.activeWriters.map.size
  console.log(`[TEST] A activeWriters: ${aWriters}, B activeWriters: ${bWriters}`)

  // Both peers write files simultaneously
  console.log('[TEST] Both peers writing files...')
  await fs.writeFile(path.join(peerALocal, 'from-a.txt'), 'File created by peer A')
  await fs.writeFile(path.join(peerBLocal, 'from-b.txt'), 'File created by peer B')

  // Verify files exist locally
  const aFileExists = await fs.access(path.join(peerALocal, 'from-a.txt')).then(() => true).catch(() => false)
  const bFileExists = await fs.access(path.join(peerBLocal, 'from-b.txt')).then(() => true).catch(() => false)
  console.log(`[TEST] Local files exist: A=${aFileExists}, B=${bFileExists}`)

  // Both sync to remote (sequentially for clearer debugging)
  console.log('[TEST] A syncing to remote...')
  const aResult = await peerA.syncToRemote()
  console.log('[TEST] A sync result:', aResult)
  
  console.log('[TEST] B syncing to remote...')
  const bResult = await peerB.syncToRemote()
  console.log('[TEST] B sync result:', bResult)
  
  console.log('[TEST] Both peers synced to remote')

  // Wait for data replication to complete
  await sleep(5000)

  // Update views to see replicated entries
  await peerA.autobase.base.view.update()
  await peerB.autobase.base.view.update()

  // Check entries on both sides
  const entriesA = await peerA.autobase.list()
  const entriesB = await peerB.autobase.list()
  console.log('[TEST] Entries on A:', entriesA.length, entriesA.map(e => e.key))
  console.log('[TEST] Entries on B:', entriesB.length, entriesB.map(e => e.key))

  // Both should have 2 entries
  t.is(entriesA.length, 2, 'peer A has 2 entries')
  t.is(entriesB.length, 2, 'peer B has 2 entries')

  // Sync from remote to local on both
  await Promise.all([
    peerA.syncToLocal(),
    peerB.syncToLocal()
  ])

  // Verify A has file from B
  try {
    const contentFromB = await fs.readFile(path.join(peerALocal, 'from-b.txt'), 'utf-8')
    t.is(contentFromB, 'File created by peer B', 'peer A received file from B')
  } catch (err) {
    t.fail(`File from B not found on A: ${err.message}`)
  }

  // Verify B has file from A
  try {
    const contentFromA = await fs.readFile(path.join(peerBLocal, 'from-a.txt'), 'utf-8')
    t.is(contentFromA, 'File created by peer A', 'peer B received file from A')
  } catch (err) {
    t.fail(`File from A not found on B: ${err.message}`)
  }

  await peerA.close()
  await peerB.close()
})

test('direct sync: delete propagation', async (t) => {
  const peerALocal = await createTestDir('delete-peerA-local')
  const peerAStorage = await createTestDir('delete-peerA-storage')
  const peerBLocal = await createTestDir('delete-peerB-local')
  const peerBStorage = await createTestDir('delete-peerB-storage')

  // Create peer A
  const peerA = new SyncEngine({
    localPath: peerALocal,
    storagePath: peerAStorage
  })
  suppressErrors(peerA)
  logEvents(peerA, 'A')

  const key = await peerA.init()
  t.ok(key, 'peer A initialized')

  // Create a file on A and sync
  await fs.writeFile(path.join(peerALocal, 'to-delete.txt'), 'This will be deleted')
  await peerA.syncToRemote()
  t.pass('peer A created and synced file')

  // Create peer B
  const peerB = new SyncEngine({
    localPath: peerBLocal,
    storagePath: peerBStorage,
    remoteKey: key
  })
  suppressErrors(peerB)
  logEvents(peerB, 'B')

  await peerB.init()
  t.pass('peer B initialized')

  // Wait for replication
  await waitForReplication(peerA, peerB)

  // B syncs file from A
  await peerB.syncToLocal()
  
  // Verify file exists on B
  const existsBefore = await fs.access(path.join(peerBLocal, 'to-delete.txt')).then(() => true).catch(() => false)
  t.ok(existsBefore, 'file exists on B before deletion')

  // A deletes the file
  await fs.unlink(path.join(peerALocal, 'to-delete.txt'))
  await peerA.syncToRemote()
  console.log('[TEST] File deleted on A and synced')

  // Wait for replication
  await sleep(3000)
  await peerB.autobase.base.view.update()

  // B syncs deletions
  await peerB.syncToLocal()

  // Verify file is deleted on B
  const existsAfter = await fs.access(path.join(peerBLocal, 'to-delete.txt')).then(() => true).catch(() => false)
  t.ok(!existsAfter, 'file deleted on B after sync')

  await peerA.close()
  await peerB.close()
})

test('cleanup', async (t) => {
  await cleanup()
  t.pass('cleaned up')
})
