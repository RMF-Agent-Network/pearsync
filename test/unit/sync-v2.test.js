import test from 'brittle'
import { SyncEngine } from '../../lib/sync-v2.js'
import tmp from 'tmp-promise'
import fs from 'fs/promises'
import path from 'path'
import { setTimeout as sleep } from 'timers/promises'

async function createTempDirs() {
  const local = await tmp.dir({ unsafeCleanup: true })
  const storage = await tmp.dir({ unsafeCleanup: true })
  return {
    localPath: local.path,
    storagePath: storage.path,
    cleanup: async () => {
      await local.cleanup()
      await storage.cleanup()
    }
  }
}

// Suppress connection errors during cleanup
function suppressErrors(engine) {
  engine.on('error', () => {})
}

test('sync-v2: initializes and returns key', async (t) => {
  const { localPath, storagePath, cleanup } = await createTempDirs()

  const engine = new SyncEngine({
    localPath,
    storagePath
  })
  suppressErrors(engine)

  const key = await engine.init()

  t.ok(key, 'returns a key')
  t.is(key.length, 64, 'key is 64 hex chars')
  t.ok(engine.ready, 'engine is ready')
  t.ok(engine.isWriter, 'all peers are writers in v2')

  await engine.close()
  await cleanup()
})

test('sync-v2: pushes local file to autobase', async (t) => {
  const { localPath, storagePath, cleanup } = await createTempDirs()

  const engine = new SyncEngine({
    localPath,
    storagePath
  })
  suppressErrors(engine)

  await engine.init()

  // Create a local file
  const testFile = path.join(localPath, 'test.txt')
  await fs.writeFile(testFile, 'Hello PearSync v2!')

  // Sync to remote
  const stats = await engine.syncToRemote()

  t.is(stats.add, 1, 'one file added')

  // Check it's in the autobase
  const entries = await engine.autobase.list()
  t.is(entries.length, 1, 'one entry in autobase')
  t.is(entries[0].key, 'test.txt', 'correct key')

  await engine.close()
  await cleanup()
})

test('sync-v2: pulls file from autobase to local', async (t) => {
  const { localPath, storagePath, cleanup } = await createTempDirs()

  const engine = new SyncEngine({
    localPath,
    storagePath
  })
  suppressErrors(engine)

  await engine.init()

  // Manually add a file to autobase (simulating remote write)
  // Use embedded content format (base64)
  const content = Buffer.from('Remote content!')

  await engine.autobase.append({
    type: 'put',
    key: 'remote.txt',
    value: {
      content: content.toString('base64'),
      size: content.length,
      mtime: Date.now(),
      hash: 'fakehash'
    }
  })

  await engine.autobase.base.view.update()

  // Sync from remote
  const stats = await engine.syncToLocal()

  t.is(stats.add, 1, 'one file pulled')

  // Check local file exists
  const localContent = await fs.readFile(path.join(localPath, 'remote.txt'), 'utf-8')
  t.is(localContent, 'Remote content!', 'content matches')

  await engine.close()
  await cleanup()
})

test('sync-v2: handles deletions', async (t) => {
  const { localPath, storagePath, cleanup } = await createTempDirs()

  const engine = new SyncEngine({
    localPath,
    storagePath,
    syncDeletes: true
  })
  suppressErrors(engine)

  await engine.init()

  // Create and sync a file
  const testFile = path.join(localPath, 'delete-me.txt')
  await fs.writeFile(testFile, 'Will be deleted')
  await engine.syncToRemote()

  // Delete the file locally
  await fs.unlink(testFile)

  // Sync again
  const stats = await engine.syncToRemote()

  t.is(stats.remove, 1, 'one file removed')

  // Check autobase has no entries
  const entries = await engine.autobase.list()
  t.is(entries.length, 0, 'no entries in autobase after delete')

  await engine.close()
  await cleanup()
})

test('sync-v2: respects ignore patterns', async (t) => {
  const { localPath, storagePath, cleanup } = await createTempDirs()

  const engine = new SyncEngine({
    localPath,
    storagePath
  })
  suppressErrors(engine)

  await engine.init()

  // Create files - some should be ignored
  await fs.writeFile(path.join(localPath, 'keep.txt'), 'should sync')
  await fs.writeFile(path.join(localPath, '.DS_Store'), 'should ignore')
  await fs.mkdir(path.join(localPath, 'node_modules'), { recursive: true })
  await fs.writeFile(path.join(localPath, 'node_modules', 'pkg.json'), 'should ignore')

  const stats = await engine.syncToRemote()

  t.is(stats.add, 1, 'only one file synced')

  const entries = await engine.autobase.list()
  t.is(entries.length, 1, 'only one entry')
  t.is(entries[0].key, 'keep.txt', 'correct file synced')

  await engine.close()
  await cleanup()
})

test('sync-v2: getInfo returns correct data', async (t) => {
  const { localPath, storagePath, cleanup } = await createTempDirs()

  const engine = new SyncEngine({
    localPath,
    storagePath
  })
  suppressErrors(engine)

  await engine.init()

  // Add some files
  await fs.writeFile(path.join(localPath, 'a.txt'), 'file a')
  await fs.writeFile(path.join(localPath, 'b.txt'), 'file b')
  await engine.syncToRemote()

  const info = await engine.getInfo()

  t.ok(info.key, 'has key')
  t.is(info.fileCount, 2, 'has 2 files')
  t.ok(info.totalSize > 0, 'has size')
  t.ok(info.isWriter, 'is writer')

  await engine.close()
  await cleanup()
})

test('sync-v2: engine joins with remoteKey', async (t) => {
  // This is a unit test - just verify the engine initializes correctly with remoteKey
  // Actual peer-to-peer sync is tested in integration tests
  const peer1 = await createTempDirs()
  const peer2 = await createTempDirs()

  // Peer 1 creates workspace
  const engine1 = new SyncEngine({
    localPath: peer1.localPath,
    storagePath: peer1.storagePath
  })
  suppressErrors(engine1)

  const key = await engine1.init()
  t.ok(key, 'peer 1 initialized with key')

  // Create a file on peer 1
  await fs.writeFile(path.join(peer1.localPath, 'from-peer1.txt'), 'Hello from peer 1!')
  await engine1.syncToRemote()

  // Peer 2 joins with remoteKey
  const engine2 = new SyncEngine({
    localPath: peer2.localPath,
    storagePath: peer2.storagePath,
    remoteKey: key
  })
  suppressErrors(engine2)

  const key2 = await engine2.init()

  t.ok(key2, 'peer 2 initialized')
  t.ok(engine2.ready, 'peer 2 is ready')
  // In v2, all peers are writers
  t.ok(engine2.isWriter, 'peer 2 is also a writer')

  // Note: actual sync won't work in unit test (requires network)
  // Integration tests verify peer-to-peer sync

  await engine1.close()
  await engine2.close()
  await peer1.cleanup()
  await peer2.cleanup()
})
