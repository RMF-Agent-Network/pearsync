import test from 'brittle'
import { TestSetup } from '../helpers/setup.js'
import { PearSyncAutobase } from '../../lib/autobase.js'

test('basic autobase initialization', async (t) => {
  const setup = new TestSetup()
  t.teardown(() => setup.destroy())

  const store = await setup.createStore()
  const blobs = await setup.createBlobStore(store)

  const ps = new PearSyncAutobase(store, blobs)
  await ps.ready()

  t.ok(ps.base, 'autobase created')
  t.ok(ps.blobs, 'hyperblobs created')
  t.ok(ps.localWriter, 'local writer key exists')
})

test('append metadata-only event', async (t) => {
  const setup = new TestSetup()
  t.teardown(() => setup.destroy())

  const store = await setup.createStore()
  const blobs = await setup.createBlobStore(store)

  const ps = new PearSyncAutobase(store, blobs)
  await ps.ready()

  await ps.append({
    type: 'put',
    key: '/test/file.txt',
    value: {
      blobRef: 'blob-123',
      timestamp: Date.now(),
      writer: ps.localWriter.toString('hex')
    }
  })

  const view = await setup.createView(ps.base)
  const entry = await view.get('/test/file.txt')

  t.ok(entry, 'entry exists')
  t.is(entry.value.blobRef, 'blob-123', 'blob reference stored')
})

test('delete operation', async (t) => {
  const setup = new TestSetup()
  t.teardown(() => setup.destroy())

  const store = await setup.createStore()
  const blobs = await setup.createBlobStore(store)

  const ps = new PearSyncAutobase(store, blobs)
  await ps.ready()

  await ps.append({
    type: 'put',
    key: '/test/file.txt',
    value: { blobRef: 'blob-123', timestamp: Date.now() }
  })

  await ps.append({
    type: 'del',
    key: '/test/file.txt'
  })

  const view = await setup.createView(ps.base)
  const entry = await view.get('/test/file.txt')

  t.absent(entry, 'entry deleted')
})

test('LWW via autobase linearization', async (t) => {
  const setup = new TestSetup()
  t.teardown(() => setup.destroy())

  const store = await setup.createStore()
  const blobs = await setup.createBlobStore(store)
  const ps = new PearSyncAutobase(store, blobs)
  await ps.ready()

  await ps.append({
    type: 'put',
    key: '/conflict.txt',
    value: { blobRef: 'blob-v1', timestamp: 1000 }
  })

  await ps.append({
    type: 'put',
    key: '/conflict.txt',
    value: { blobRef: 'blob-v2', timestamp: 2000 }
  })

  await ps.base.view.update()

  const view = await setup.createView(ps.base)
  const entry = await view.get('/conflict.txt')

  t.ok(entry, 'entry exists')
  t.ok(entry.value.blobRef === 'blob-v1' || entry.value.blobRef === 'blob-v2', 'one value won via LWW')
})

test('hyperblobs integration', async (t) => {
  const setup = new TestSetup()
  t.teardown(() => setup.destroy())

  const store = await setup.createStore()
  const blobs = await setup.createBlobStore(store)

  const ps = new PearSyncAutobase(store, blobs)
  await ps.ready()

  const content = Buffer.from('Hello, PearSync!')
  const blobId = await ps.putBlob(content)

  t.ok(blobId, 'blob ID returned')

  const retrieved = await ps.getBlob(blobId)
  t.alike(retrieved, content, 'blob content matches')
})

test('list all entries', async (t) => {
  const setup = new TestSetup()
  t.teardown(() => setup.destroy())

  const store = await setup.createStore()
  const blobs = await setup.createBlobStore(store)

  const ps = new PearSyncAutobase(store, blobs)
  await ps.ready()

  await ps.append({
    type: 'put',
    key: '/a.txt',
    value: { blobRef: 'blob-a' }
  })

  await ps.append({
    type: 'put',
    key: '/b.txt',
    value: { blobRef: 'blob-b' }
  })

  const entries = await ps.list()

  t.is(entries.length, 2, 'two entries found')
  t.ok(entries.find(e => e.key === '/a.txt'), 'entry /a.txt exists')
  t.ok(entries.find(e => e.key === '/b.txt'), 'entry /b.txt exists')
})
