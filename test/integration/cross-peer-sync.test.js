/**
 * Cross-Peer Sync Integration Test
 * 
 * Tests actual peer-to-peer sync between two SyncEngine instances
 * running in the same process (simulates cross-machine sync)
 */

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { setTimeout as sleep } from 'timers/promises'
import { SyncEngine } from '../../lib/sync-v2.js'

const TEST_DIR = path.join(os.tmpdir(), `pearsync-integration-${Date.now()}`)

// Helper to wait for peer connection with longer timeout
async function waitForConnection(peerA, peerB, timeoutMs = 30000) {
  return Promise.race([
    new Promise(resolve => {
      const onJoin = () => {
        peerA.removeListener('peer-join', onJoin)
        peerB.removeListener('peer-join', onJoin)
        resolve(true)
      }
      peerA.on('peer-join', onJoin)
      peerB.on('peer-join', onJoin)
    }),
    sleep(timeoutMs).then(() => false)
  ])
}

// Suppress connection reset errors during cleanup (expected behavior)
function suppressErrors(engine) {
  engine.on('error', () => {})
}

async function createTestDir(name) {
  const dir = path.join(TEST_DIR, name)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function cleanup() {
  await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
}

test('two-peer sync: file created on peer A appears on peer B', async (t) => {
  const peerALocal = await createTestDir('peerA-local')
  const peerAStorage = await createTestDir('peerA-storage')
  const peerBLocal = await createTestDir('peerB-local')
  const peerBStorage = await createTestDir('peerB-storage')

  // Peer A creates workspace (writer)
  const peerA = new SyncEngine({
    localPath: peerALocal,
    storagePath: peerAStorage,
    syncDeletes: true
  })
  suppressErrors(peerA)

  const key = await peerA.init()
  t.ok(key, 'peer A initialized with key')

  // Peer B joins workspace (reader initially, but v2 makes all writers)
  const peerB = new SyncEngine({
    localPath: peerBLocal,
    storagePath: peerBStorage,
    remoteKey: key,
    syncDeletes: true
  })
  suppressErrors(peerB)

  await peerB.init()
  t.pass('peer B joined')

  // Wait for peer connection (longer timeout - DHT discovery can be slow)
  await waitForConnection(peerA, peerB, 30000)
  // Don't fail if connection times out - sync might still work via direct replication
  t.pass('waited for peer connection')

  // Peer A creates a file
  const testContent = 'Hello from Peer A! ' + Date.now()
  await fs.writeFile(path.join(peerALocal, 'test.txt'), testContent)

  // Peer A syncs to remote
  await peerA.syncToRemote()
  t.pass('peer A synced to remote')

  // Give time for replication
  await sleep(3000)

  // Peer B syncs from remote
  await peerB.syncToLocal()

  // Check file appeared on peer B
  const peerBContent = await fs.readFile(path.join(peerBLocal, 'test.txt'), 'utf-8')
  t.is(peerBContent, testContent, 'file content matches on peer B')

  await peerA.close()
  await peerB.close()
})

test('bidirectional sync: changes from both peers', async (t) => {
  const peerALocal = await createTestDir('bidir-peerA-local')
  const peerAStorage = await createTestDir('bidir-peerA-storage')
  const peerBLocal = await createTestDir('bidir-peerB-local')
  const peerBStorage = await createTestDir('bidir-peerB-storage')

  // Peer A creates workspace
  const peerA = new SyncEngine({
    localPath: peerALocal,
    storagePath: peerAStorage,
    syncDeletes: true
  })
  suppressErrors(peerA)

  const key = await peerA.init()

  // Peer B joins
  const peerB = new SyncEngine({
    localPath: peerBLocal,
    storagePath: peerBStorage,
    remoteKey: key,
    syncDeletes: true
  })
  suppressErrors(peerB)

  await peerB.init()

  // Wait for connection
  await waitForConnection(peerA, peerB, 30000)

  // Peer A creates file1
  await fs.writeFile(path.join(peerALocal, 'from-a.txt'), 'Created by A')
  await peerA.syncToRemote()

  // Give replication time
  await sleep(3000)

  // Peer B creates file2
  await fs.writeFile(path.join(peerBLocal, 'from-b.txt'), 'Created by B')
  await peerB.syncToRemote()

  // Give replication time
  await sleep(3000)

  // Both sync from remote
  await peerA.syncToLocal()
  await peerB.syncToLocal()

  // Verify both peers have both files
  const aHasB = await fs.readFile(path.join(peerALocal, 'from-b.txt'), 'utf-8')
  const bHasA = await fs.readFile(path.join(peerBLocal, 'from-a.txt'), 'utf-8')

  t.is(aHasB, 'Created by B', 'peer A has file from B')
  t.is(bHasA, 'Created by A', 'peer B has file from A')

  await peerA.close()
  await peerB.close()
})

test('delete propagation: delete on peer A removes from peer B', async (t) => {
  const peerALocal = await createTestDir('delete-peerA-local')
  const peerAStorage = await createTestDir('delete-peerA-storage')
  const peerBLocal = await createTestDir('delete-peerB-local')
  const peerBStorage = await createTestDir('delete-peerB-storage')

  const peerA = new SyncEngine({
    localPath: peerALocal,
    storagePath: peerAStorage,
    syncDeletes: true
  })
  suppressErrors(peerA)

  const key = await peerA.init()

  const peerB = new SyncEngine({
    localPath: peerBLocal,
    storagePath: peerBStorage,
    remoteKey: key,
    syncDeletes: true
  })
  suppressErrors(peerB)

  await peerB.init()

  await waitForConnection(peerA, peerB, 30000)

  // Create and sync file
  await fs.writeFile(path.join(peerALocal, 'to-delete.txt'), 'Will be deleted')
  await peerA.syncToRemote()
  await sleep(2000)
  await peerB.syncToLocal()

  // Verify file exists on B
  const existsBefore = await fs.access(path.join(peerBLocal, 'to-delete.txt')).then(() => true).catch(() => false)
  t.ok(existsBefore, 'file exists on peer B before delete')

  // Delete on A and sync
  await fs.unlink(path.join(peerALocal, 'to-delete.txt'))
  await peerA.syncToRemote()
  await sleep(2000)
  await peerB.syncToLocal()

  // Verify file is gone on B
  const existsAfter = await fs.access(path.join(peerBLocal, 'to-delete.txt')).then(() => true).catch(() => false)
  t.ok(!existsAfter, 'file removed from peer B after delete')

  await peerA.close()
  await peerB.close()
})

test('large file streaming: 5MB file syncs without memory issues', async (t) => {
  const peerALocal = await createTestDir('large-peerA-local')
  const peerAStorage = await createTestDir('large-peerA-storage')
  const peerBLocal = await createTestDir('large-peerB-local')
  const peerBStorage = await createTestDir('large-peerB-storage')

  const peerA = new SyncEngine({
    localPath: peerALocal,
    storagePath: peerAStorage,
    syncDeletes: true
  })
  suppressErrors(peerA)

  const key = await peerA.init()

  const peerB = new SyncEngine({
    localPath: peerBLocal,
    storagePath: peerBStorage,
    remoteKey: key,
    syncDeletes: true
  })
  suppressErrors(peerB)

  await peerB.init()

  await waitForConnection(peerA, peerB, 30000)

  // Create 5MB file
  const largeContent = Buffer.alloc(5 * 1024 * 1024, 'A')
  await fs.writeFile(path.join(peerALocal, 'large.bin'), largeContent)

  const memBefore = process.memoryUsage().heapUsed

  await peerA.syncToRemote()
  await sleep(5000) // Allow time for large file replication
  await peerB.syncToLocal()

  const memAfter = process.memoryUsage().heapUsed
  const memIncrease = (memAfter - memBefore) / 1024 / 1024

  // Verify file synced correctly
  const peerBFile = await fs.readFile(path.join(peerBLocal, 'large.bin'))
  t.is(peerBFile.length, largeContent.length, 'large file size matches')
  t.ok(peerBFile.equals(largeContent), 'large file content matches')

  // Memory should not increase by more than 50MB (streaming should prevent loading entire file)
  t.ok(memIncrease < 50, `memory increase reasonable: ${memIncrease.toFixed(1)}MB`)

  await peerA.close()
  await peerB.close()
})

test('ignore patterns: .pearsyncignore respected', async (t) => {
  const peerALocal = await createTestDir('ignore-peerA-local')
  const peerAStorage = await createTestDir('ignore-peerA-storage')
  const peerBLocal = await createTestDir('ignore-peerB-local')
  const peerBStorage = await createTestDir('ignore-peerB-storage')

  // Create .pearsyncignore on peer A
  await fs.writeFile(path.join(peerALocal, '.pearsyncignore'), '*.log\nsecret/\n')

  const peerA = new SyncEngine({
    localPath: peerALocal,
    storagePath: peerAStorage,
    syncDeletes: true
  })
  suppressErrors(peerA)

  const key = await peerA.init()

  const peerB = new SyncEngine({
    localPath: peerBLocal,
    storagePath: peerBStorage,
    remoteKey: key,
    syncDeletes: true
  })
  suppressErrors(peerB)

  await peerB.init()

  await waitForConnection(peerA, peerB, 30000)

  // Create files - some should be ignored
  await fs.writeFile(path.join(peerALocal, 'sync-me.txt'), 'should sync')
  await fs.writeFile(path.join(peerALocal, 'debug.log'), 'should NOT sync')
  await fs.mkdir(path.join(peerALocal, 'secret'), { recursive: true })
  await fs.writeFile(path.join(peerALocal, 'secret', 'passwords.txt'), 'should NOT sync')

  await peerA.syncToRemote()
  await sleep(2000)
  await peerB.syncToLocal()

  // Verify synced files
  const syncedExists = await fs.access(path.join(peerBLocal, 'sync-me.txt')).then(() => true).catch(() => false)
  t.ok(syncedExists, 'non-ignored file synced')

  // Verify ignored files did NOT sync
  const logExists = await fs.access(path.join(peerBLocal, 'debug.log')).then(() => true).catch(() => false)
  t.ok(!logExists, '*.log pattern ignored')

  const secretExists = await fs.access(path.join(peerBLocal, 'secret')).then(() => true).catch(() => false)
  t.ok(!secretExists, 'secret/ directory ignored')

  await peerA.close()
  await peerB.close()
})

test('late joiner: peer B gets full state after peer A has made changes', async (t) => {
  const peerALocal = await createTestDir('late-peerA-local')
  const peerAStorage = await createTestDir('late-peerA-storage')
  const peerBLocal = await createTestDir('late-peerB-local')
  const peerBStorage = await createTestDir('late-peerB-storage')

  // Peer A creates workspace and makes several changes BEFORE B joins
  const peerA = new SyncEngine({
    localPath: peerALocal,
    storagePath: peerAStorage,
    syncDeletes: true
  })
  suppressErrors(peerA)

  const key = await peerA.init()

  // Create multiple files
  for (let i = 1; i <= 5; i++) {
    await fs.writeFile(path.join(peerALocal, `file${i}.txt`), `Content ${i}`)
  }
  await fs.mkdir(path.join(peerALocal, 'subdir'), { recursive: true })
  await fs.writeFile(path.join(peerALocal, 'subdir', 'nested.txt'), 'Nested content')

  await peerA.syncToRemote()

  // NOW peer B joins (late joiner)
  const peerB = new SyncEngine({
    localPath: peerBLocal,
    storagePath: peerBStorage,
    remoteKey: key,
    syncDeletes: true
  })
  suppressErrors(peerB)

  await peerB.init()

  await waitForConnection(peerA, peerB, 30000)

  await peerB.syncToLocal()

  // Verify B has all files
  for (let i = 1; i <= 5; i++) {
    const content = await fs.readFile(path.join(peerBLocal, `file${i}.txt`), 'utf-8')
    t.is(content, `Content ${i}`, `file${i}.txt synced to late joiner`)
  }

  const nested = await fs.readFile(path.join(peerBLocal, 'subdir', 'nested.txt'), 'utf-8')
  t.is(nested, 'Nested content', 'nested file synced to late joiner')

  await peerA.close()
  await peerB.close()
})

// Cleanup after all tests
test.configure({ serial: true })
test('cleanup', async (t) => {
  await cleanup()
  t.pass('cleaned up test directories')
})
