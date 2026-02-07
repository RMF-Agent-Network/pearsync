/**
 * Autobase + Hyperswarm with proper error handling
 */
import test from 'brittle'
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import tmp from 'tmp-promise'
import { setTimeout as sleep } from 'timers/promises'

function open(store) {
  return store.get('view', { valueEncoding: 'json' })
}

async function apply(nodes, view, base) {
  for (const node of nodes) {
    console.log('[apply] op:', JSON.stringify(node.value)?.slice(0, 60))
    if (node.value?.type === 'add-writer') {
      const key = b4a.from(node.value.writerKey, 'hex')
      await base.addWriter(key, { indexer: true })
    }
    await view.append(node.value)
  }
}

test('autobase over hyperswarm', async (t) => {
  const tmpA = await tmp.dir({ unsafeCleanup: true })
  const tmpB = await tmp.dir({ unsafeCleanup: true })
  
  const storeA = new Corestore(tmpA.path)
  const storeB = new Corestore(tmpB.path)
  await storeA.ready()
  await storeB.ready()

  // Create A
  const a = new Autobase(storeA, { valueEncoding: 'json', open, apply })
  await a.ready()
  console.log('A key:', b4a.toString(a.key, 'hex').slice(0, 16))

  // Create B
  const b = new Autobase(storeB, a.key, { valueEncoding: 'json', open, apply })
  await b.ready()
  console.log('B key:', b4a.toString(b.local.key, 'hex').slice(0, 16))

  const swarmA = new Hyperswarm()
  const swarmB = new Hyperswarm()

  t.teardown(async () => {
    await swarmA.destroy()
    await swarmB.destroy()
    await a.close()
    await b.close()
    await storeA.close()
    await storeB.close()
    await tmpA.cleanup()
    await tmpB.cleanup()
  })

  // Track active replication streams
  const replStreams = []

  swarmA.on('connection', (socket, info) => {
    console.log('A: peer connected, client:', info.client)
    const repl = storeA.replicate(socket)
    replStreams.push(repl)
    repl.on('error', (e) => console.log('A repl error:', e.message))
  })

  swarmB.on('connection', (socket, info) => {
    console.log('B: peer connected, client:', info.client)
    const repl = storeB.replicate(socket)
    replStreams.push(repl)
    repl.on('error', (e) => console.log('B repl error:', e.message))
  })

  // Join using autobase discovery key
  const topic = a.discoveryKey
  console.log('Topic (a.discoveryKey):', b4a.toString(topic, 'hex').slice(0, 16))

  const discA = swarmA.join(topic, { server: true, client: true })
  const discB = swarmB.join(topic, { server: true, client: true })
  
  await discA.flushed()
  await discB.flushed()
  console.log('Swarms flushed')

  // Wait for connection to stabilize
  await sleep(2000)
  console.log('After 2s wait')

  // A adds B as writer
  console.log('A appending add-writer...')
  await a.append({ type: 'add-writer', writerKey: b4a.toString(b.local.key, 'hex') })
  await a.update()
  console.log('A.local.length:', a.local.length, 'A.view.length:', a.view.length)

  // Poll B
  for (let i = 0; i < 15; i++) {
    await sleep(500)
    await b.update()
    console.log(`[${i+1}] B.view.length:`, b.view.length, 'B.writable:', b.writable)
    if (b.writable) break
  }

  t.ok(b.writable, 'B should become writable')
})
