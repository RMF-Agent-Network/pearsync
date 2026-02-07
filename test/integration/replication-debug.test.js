/**
 * Debug test for Autobase replication
 */
import test from 'brittle'
import Autobase from 'autobase'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import tmp from 'tmp-promise'
import { setTimeout as sleep } from 'timers/promises'

function open(store) {
  return store.get('view', { valueEncoding: 'json' })
}

async function apply(nodes, view, base) {
  for (const node of nodes) {
    if (node.value && node.value.add) {
      await base.addWriter(Buffer.from(node.value.add, 'hex'))
    }
    await view.append(node.value)
  }
}

test('debug: autobase replication over hyperswarm', async (t) => {
  const tmpA = await tmp.dir({ unsafeCleanup: true })
  const tmpB = await tmp.dir({ unsafeCleanup: true })
  t.teardown(async () => {
    await swarmA.destroy()
    await swarmB.destroy()
    await a.close()
    await b.close()
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
  console.log('A discoveryKey:', b4a.toString(a.discoveryKey, 'hex').slice(0, 16))

  // A appends some data
  await a.append({ msg: 'hello from A', ts: Date.now() })
  console.log('A view length after append:', a.view.length)

  // Create autobase B with A's key
  const b = new Autobase(storeB, a.key, {
    valueEncoding: 'json',
    open,
    apply
  })
  await b.ready()

  console.log('B key:', b4a.toString(b.key, 'hex').slice(0, 16))
  console.log('B view length initially:', b.view.length)

  // Set up Hyperswarm for both
  const swarmA = new Hyperswarm()
  const swarmB = new Hyperswarm()

  swarmA.on('connection', (socket, info) => {
    console.log('A: peer connected')
    storeA.replicate(socket)
  })

  swarmB.on('connection', (socket, info) => {
    console.log('B: peer connected')
    storeB.replicate(socket)
  })

  // Join the same topic
  const topic = a.discoveryKey
  
  console.log('Joining swarm...')
  const discoveryA = swarmA.join(topic, { server: true, client: true })
  const discoveryB = swarmB.join(topic, { server: true, client: true })

  await discoveryA.flushed()
  await discoveryB.flushed()
  console.log('Swarm flushed')

  // Wait for connection
  await sleep(3000)

  console.log('After 3s wait:')
  console.log('B view length:', b.view.length)

  // Try updating B
  console.log('Calling b.update()...')
  await b.update()
  console.log('B view length after update:', b.view.length)

  // Wait more and try again
  await sleep(3000)
  await b.update()
  console.log('B view length after 6s + update:', b.view.length)

  // Check activeWriters
  console.log('A activeWriters:', a.activeWriters.map.size)
  console.log('B activeWriters:', b.activeWriters.map.size)

  // Try to read from B
  if (b.view.length > 0) {
    const entry = await b.view.get(0)
    console.log('B view[0]:', entry)
  }

  t.ok(b.view.length > 0, 'B should have replicated data')
})
