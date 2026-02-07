/**
 * Test without Hyperswarm - direct stream replication
 */
import test from 'brittle'
import Corestore from 'corestore'
import Autobase from 'autobase'
import b4a from 'b4a'
import tmp from 'tmp-promise'
import { setTimeout as sleep } from 'timers/promises'

function open(store) {
  return store.get('view', { valueEncoding: 'json' })
}

async function apply(nodes, view, base) {
  for (const node of nodes) {
    console.log('[apply] processing:', JSON.stringify(node.value))
    
    if (node.value?.type === 'add-writer') {
      const key = b4a.from(node.value.writerKey, 'hex')
      console.log('[apply] calling addWriter for:', node.value.writerKey.slice(0, 16))
      await base.addWriter(key, { indexer: true })
      console.log('[apply] addWriter done')
    }
    await view.append(node.value)
  }
}

test('direct replication: B becomes writable', async (t) => {
  const tmpA = await tmp.dir({ unsafeCleanup: true })
  const tmpB = await tmp.dir({ unsafeCleanup: true })
  
  const storeA = new Corestore(tmpA.path)
  const storeB = new Corestore(tmpB.path)
  await storeA.ready()
  await storeB.ready()

  // Create A
  const a = new Autobase(storeA, { valueEncoding: 'json', open, apply })
  await a.ready()
  console.log('A ready, key:', b4a.toString(a.key, 'hex').slice(0, 16))

  // Create B with A's bootstrap key
  const b = new Autobase(storeB, a.key, { valueEncoding: 'json', open, apply })
  await b.ready()
  console.log('B ready, local key:', b4a.toString(b.local.key, 'hex').slice(0, 16))
  console.log('B.writable initially:', b.writable)

  // Direct stream replication (no Hyperswarm)
  const s1 = storeA.replicate(true)
  const s2 = storeB.replicate(false)
  s1.pipe(s2).pipe(s1)
  console.log('Replication streams connected')

  await sleep(500)

  // A adds B as writer
  const bKey = b4a.toString(b.local.key, 'hex')
  console.log('A appending add-writer for B...')
  await a.append({ type: 'add-writer', writerKey: bKey })
  await a.update()
  console.log('A.local.length:', a.local.length)
  console.log('A.view.length:', a.view.length)

  // Wait and update B
  for (let i = 0; i < 10; i++) {
    await sleep(500)
    await b.update()
    console.log(`[${i+1}] B.view.length:`, b.view.length, 'B.writable:', b.writable)
    if (b.writable) break
  }

  t.ok(b.writable, 'B should become writable')

  // Cleanup
  s1.destroy()
  s2.destroy()
  await a.close()
  await b.close()
  await storeA.close()
  await storeB.close()
  await tmpA.cleanup()
  await tmpB.cleanup()
})
