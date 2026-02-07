import test from 'brittle'
import { TestSetup } from '../helpers/setup.js'
import { PearSyncAutobase } from '../../lib/autobase.js'
import b4a from 'b4a'

// Helper to replicate two stores
async function replicateStores(store1, store2) {
  const s1 = store1.replicate(true)
  const s2 = store2.replicate(false)
  s1.pipe(s2).pipe(s1)
  await new Promise(resolve => setTimeout(resolve, 500))
  s1.destroy()
  s2.destroy()
}

test('add writer with replication', async (t) => {
  const setup = new TestSetup()
  t.teardown(() => setup.destroy())

  const store1 = await setup.createStore()
  const blobs1 = await setup.createBlobStore(store1)
  const ps1 = new PearSyncAutobase(store1, blobs1)
  await ps1.ready()

  // Create ps2 with ps1's key as bootstrap
  const store2 = await setup.createStore()
  const blobs2 = await setup.createBlobStore(store2)
  const ps2 = new PearSyncAutobase(store2, blobs2, [ps1.localWriter])
  await ps2.ready()

  // Replicate stores first
  await replicateStores(store1, store2)

  const writersBefore = ps1.base.activeWriters.map.size
  await ps1.addWriter(ps2.localWriter)

  // Replicate again to sync the add-writer message
  await replicateStores(store1, store2)

  const writersAfter = ps1.base.activeWriters.map.size
  t.is(writersAfter, writersBefore + 1, 'writer added')

  const hasWriter = ps1.base.activeWriters.map.has(b4a.toString(ps2.localWriter, 'hex'))
  t.ok(hasWriter, 'new writer is in active writers')
})

test('self-remove writer only', async (t) => {
  const setup = new TestSetup()
  t.teardown(() => setup.destroy())

  const store = await setup.createStore()
  const blobs = await setup.createBlobStore(store)
  const ps = new PearSyncAutobase(store, blobs)
  await ps.ready()

  t.ok(ps.base.activeWriters.map.has(b4a.toString(ps.localWriter, 'hex')), 'local writer initially present')

  await ps.removeWriter(ps.localWriter)

  t.absent(ps.base.activeWriters.map.has(b4a.toString(ps.localWriter, 'hex')), 'local writer removed')
})

test('cannot remove other writers', async (t) => {
  const setup = new TestSetup()
  t.teardown(() => setup.destroy())

  const store1 = await setup.createStore()
  const blobs1 = await setup.createBlobStore(store1)
  const ps1 = new PearSyncAutobase(store1, blobs1)
  await ps1.ready()

  const store2 = await setup.createStore()
  const blobs2 = await setup.createBlobStore(store2)
  const ps2 = new PearSyncAutobase(store2, blobs2, [ps1.localWriter])
  await ps2.ready()

  // Replicate
  await replicateStores(store1, store2)

  await ps1.addWriter(ps2.localWriter)
  await replicateStores(store1, store2)

  const writersBefore = ps1.base.activeWriters.map.size

  await ps1.removeWriter(ps2.localWriter)

  const writersAfter = ps1.base.activeWriters.map.size
  t.is(writersAfter, writersBefore, 'writer NOT removed (self-remove only)')

  const hasWriter = ps1.base.activeWriters.map.has(b4a.toString(ps2.localWriter, 'hex'))
  t.ok(hasWriter, 'other writer still present')
})

test('writer operations via addWriter method', async (t) => {
  const setup = new TestSetup()
  t.teardown(() => setup.destroy())

  const store1 = await setup.createStore()
  const blobs1 = await setup.createBlobStore(store1)
  const ps1 = new PearSyncAutobase(store1, blobs1)
  await ps1.ready()

  const store2 = await setup.createStore()
  const blobs2 = await setup.createBlobStore(store2)
  const ps2 = new PearSyncAutobase(store2, blobs2, [ps1.localWriter])
  await ps2.ready()

  await replicateStores(store1, store2)

  await ps1.addWriter(ps2.localWriter)
  await replicateStores(store1, store2)

  const hasWriter = ps1.base.activeWriters.map.has(b4a.toString(ps2.localWriter, 'hex'))
  t.ok(hasWriter, 'writer added via addWriter method')
})

test('multiple writers can be added', async (t) => {
  const setup = new TestSetup()
  t.teardown(() => setup.destroy())

  const store1 = await setup.createStore()
  const blobs1 = await setup.createBlobStore(store1)
  const ps1 = new PearSyncAutobase(store1, blobs1)
  await ps1.ready()

  const store2 = await setup.createStore()
  const blobs2 = await setup.createBlobStore(store2)
  const ps2 = new PearSyncAutobase(store2, blobs2, [ps1.localWriter])
  await ps2.ready()

  const store3 = await setup.createStore()
  const blobs3 = await setup.createBlobStore(store3)
  const ps3 = new PearSyncAutobase(store3, blobs3, [ps1.localWriter])
  await ps3.ready()

  // Replicate all stores
  await replicateStores(store1, store2)
  await replicateStores(store1, store3)

  await ps1.addWriter(ps2.localWriter)
  await ps1.addWriter(ps3.localWriter)

  // Replicate again
  await replicateStores(store1, store2)
  await replicateStores(store1, store3)

  t.is(ps1.base.activeWriters.map.size, 3, 'three writers total (local + 2 added)')
})
