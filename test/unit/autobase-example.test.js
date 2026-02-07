/**
 * Test that matches the Autobase basic example exactly
 */
import test from 'brittle'
import Autobase from 'autobase'
import Corestore from 'corestore'
import b4a from 'b4a'
import tmp from 'tmp-promise'

function open(store) {
  return store.get('view', { valueEncoding: 'json' })
}

async function apply(nodes, view, base) {
  for (const node of nodes) {
    if (node.value && node.value.add) {
      console.log('[apply] Adding writer:', node.value.add.slice(0, 16))
      await base.addWriter(Buffer.from(node.value.add, 'hex'))
    }
    await view.append(node.value)
  }
}

// Simple replication helper
async function replicateAndSync(bases) {
  const streams = []
  
  // Create replication streams
  for (let i = 0; i < bases.length; i++) {
    for (let j = i + 1; j < bases.length; j++) {
      const s1 = bases[i].replicate(true)
      const s2 = bases[j].replicate(false)
      s1.pipe(s2).pipe(s1)
      streams.push(s1, s2)
    }
  }
  
  // Wait for replication
  await new Promise(resolve => setTimeout(resolve, 500))
  
  // Update all bases
  for (const base of bases) {
    await base.update()
  }
  
  // Cleanup
  for (const s of streams) {
    s.destroy()
  }
}

test('autobase example: add writer and sync', async (t) => {
  const tmpA = await tmp.dir({ unsafeCleanup: true })
  const tmpB = await tmp.dir({ unsafeCleanup: true })
  t.teardown(async () => {
    await tmpA.cleanup()
    await tmpB.cleanup()
  })

  const storeA = new Corestore(tmpA.path)
  const storeB = new Corestore(tmpB.path)

  // Create autobase A
  const a = new Autobase(storeA, {
    valueEncoding: 'json',
    open,
    apply
  })
  await a.ready()

  console.log('A key:', b4a.toString(a.key, 'hex').slice(0, 16))
  console.log('A local key:', b4a.toString(a.local.key, 'hex').slice(0, 16))

  // Create autobase B with A's key as bootstrap
  const b = new Autobase(storeB, a.key, {
    valueEncoding: 'json',
    open,
    apply
  })
  await b.ready()

  console.log('B key:', b4a.toString(b.key, 'hex').slice(0, 16))
  console.log('B local key:', b4a.toString(b.local.key, 'hex').slice(0, 16))

  // A adds B as a writer
  console.log('A adding B as writer...')
  await a.append({
    add: b.local.key.toString('hex')
  })

  console.log('Before replication:')
  console.log('A activeWriters:', a.activeWriters.map.size)
  console.log('B activeWriters:', b.activeWriters.map.size)

  // Replicate
  await replicateAndSync([a, b])

  console.log('After replication:')
  console.log('A activeWriters:', a.activeWriters.map.size)
  console.log('B activeWriters:', b.activeWriters.map.size)

  // B should now be able to append
  console.log('B appending...')
  await b.append('hello from B')

  // Replicate again
  await replicateAndSync([a, b])

  // Check view
  console.log('A view length:', a.view.length)
  console.log('B view length:', b.view.length)

  // Both should have 2 entries
  t.ok(a.view.length >= 2, 'A has entries')
  t.ok(b.view.length >= 2, 'B has entries')

  await a.close()
  await b.close()
})
