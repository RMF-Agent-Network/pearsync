import test from 'brittle'
import { SyncEngine } from '../../lib/sync-engine.js'
import { PearSyncAutobase } from '../../lib/autobase.js'
import Corestore from 'corestore'
import Hyperblobs from 'hyperblobs'
import RAM from 'random-access-memory'
import tmp from 'tmp-promise'
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'

const tmpdir = tmp.dir

async function createAutobase () {
  const storeTmp = await tmpdir({ unsafeCleanup: true })
  const store = new Corestore(storeTmp.path)
  await store.ready()
  const core = store.get({ name: 'blobs' })
  const blobs = new Hyperblobs(core)
  await blobs.ready()
  const autobase = new PearSyncAutobase(store, blobs)
  await autobase.ready()
  return { store, blobs, autobase, cleanup: storeTmp.cleanup }
}

test('push: local file to Autobase + Hyperblobs', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const { autobase, cleanup: cleanupStore } = await createAutobase()

  const engine = new SyncEngine(dir, autobase)
  await engine.ready()

  const testFile = path.join(dir, 'test.txt')
  await fs.writeFile(testFile, 'hello world')

  await engine.pushFile('test.txt')

  const entries = await autobase.list()
  t.is(entries.length, 1, 'should have one entry')
  t.is(entries[0].key, 'test.txt', 'should have correct key')
  t.ok(entries[0].value.blobId, 'should have blob ID')
  t.is(entries[0].value.size, 11, 'should have correct size')

  const content = await autobase.getBlob(entries[0].value.blobId)
  t.alike(content, Buffer.from('hello world'), 'should have correct content')

  await engine.close()
  await autobase.close()
  await cleanup()
  await cleanupStore()
})

test('push: local deletion to del event', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const { autobase, cleanup: cleanupStore } = await createAutobase()

  const engine = new SyncEngine(dir, autobase)
  await engine.ready()

  const testFile = path.join(dir, 'test.txt')
  await fs.writeFile(testFile, 'hello')

  await engine.pushFile('test.txt')
  let entries = await autobase.list()
  t.is(entries.length, 1, 'should have one entry')

  await engine.pushDelete('test.txt')

  entries = await autobase.list()
  t.is(entries.length, 0, 'should have zero entries after delete')

  await engine.close()
  await autobase.close()
  await cleanup()
  await cleanupStore()
})

test('pull: remote file to local filesystem', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const { autobase, cleanup: cleanupStore } = await createAutobase()

  const content = Buffer.from('remote content')
  const blobId = await autobase.putBlob(content)

  await autobase.append({
    type: 'put',
    key: 'remote.txt',
    value: {
      blobId,
      size: content.length,
      mtime: Date.now()
    }
  })

  await autobase.base.view.update()

  const engine = new SyncEngine(dir, autobase)
  await engine.ready()

  await engine.pullFile('remote.txt')

  const testFile = path.join(dir, 'remote.txt')
  const localContent = await fs.readFile(testFile, 'utf-8')
  t.is(localContent, 'remote content', 'should write correct content')

  await engine.close()
  await autobase.close()
  await cleanup()
  await cleanupStore()
})

test('pull: remote deletion to local deletion', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const { autobase, cleanup: cleanupStore } = await createAutobase()

  const testFile = path.join(dir, 'test.txt')
  await fs.writeFile(testFile, 'will be deleted')

  await autobase.append({
    type: 'del',
    key: 'test.txt'
  })

  await autobase.base.view.update()

  const engine = new SyncEngine(dir, autobase)
  await engine.ready()

  await engine.pullDelete('test.txt')

  try {
    await fs.access(testFile)
    t.fail('file should not exist')
  } catch (err) {
    t.is(err.code, 'ENOENT', 'file should be deleted')
  }

  await engine.close()
  await autobase.close()
  await cleanup()
  await cleanupStore()
})

test('diff: only sync changed files (mtime + hash comparison)', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const { autobase, cleanup: cleanupStore } = await createAutobase()

  const engine = new SyncEngine(dir, autobase)
  await engine.ready()

  const testFile = path.join(dir, 'test.txt')
  await fs.writeFile(testFile, 'original')

  await engine.pushFile('test.txt')
  const entries1 = await autobase.list()
  const originalHash = entries1[0].value.hash

  // No changes - should skip
  const needsSync1 = await engine.needsSync('test.txt')
  t.is(needsSync1, false, 'should not need sync when unchanged')

  // Modify file
  await fs.writeFile(testFile, 'modified')

  const needsSync2 = await engine.needsSync('test.txt')
  t.is(needsSync2, true, 'should need sync when changed')

  await engine.pushFile('test.txt')
  const entries2 = await autobase.list()
  t.not(entries2[0].value.hash, originalHash, 'should have different hash')

  await engine.close()
  await autobase.close()
  await cleanup()
  await cleanupStore()
})

test('stream large files (dont load into memory)', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const { autobase, cleanup: cleanupStore } = await createAutobase()

  const engine = new SyncEngine(dir, autobase)
  await engine.ready()

  // Create 5MB file
  const testFile = path.join(dir, 'large.bin')
  const largeContent = crypto.randomBytes(5 * 1024 * 1024)
  await fs.writeFile(testFile, largeContent)

  await engine.pushFile('large.bin')

  const entries = await autobase.list()
  t.is(entries.length, 1, 'should have one entry')
  t.is(entries[0].value.size, largeContent.length, 'should have correct size')

  const retrievedContent = await autobase.getBlob(entries[0].value.blobId)
  t.alike(retrievedContent, largeContent, 'should have correct content')

  await engine.close()
  await autobase.close()
  await cleanup()
  await cleanupStore()
})

test('preserve file permissions and mtime', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const { autobase, cleanup: cleanupStore } = await createAutobase()

  const engine = new SyncEngine(dir, autobase)
  await engine.ready()

  const testFile = path.join(dir, 'test.txt')
  await fs.writeFile(testFile, 'hello')
  await fs.chmod(testFile, 0o755)

  const statBefore = await fs.stat(testFile)

  await engine.pushFile('test.txt')
  const entries = await autobase.list()

  t.ok(entries[0].value.mtime, 'should store mtime')
  t.ok(entries[0].value.mode, 'should store mode')
  t.is(entries[0].value.mode, statBefore.mode, 'should preserve mode')

  // Pull to new directory
  const { path: dir2, cleanup: cleanup2 } = await tmpdir({ unsafeCleanup: true })
  const engine2 = new SyncEngine(dir2, autobase)
  await engine2.ready()

  await engine2.pullFile('test.txt')

  const testFile2 = path.join(dir2, 'test.txt')
  const statAfter = await fs.stat(testFile2)

  t.is(statAfter.mode, statBefore.mode, 'should restore mode')

  await engine.close()
  await engine2.close()
  await autobase.close()
  await cleanup()
  await cleanup2()
  await cleanupStore()
})
