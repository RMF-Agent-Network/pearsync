import Autobase from 'autobase'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
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

async function main() {
  const tmpA = await tmp.dir({ unsafeCleanup: true })
  const tmpB = await tmp.dir({ unsafeCleanup: true })

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
  console.log('A local:', b4a.toString(a.local.key, 'hex').slice(0, 16))
  console.log('A writable:', a.writable)

  // Create autobase B with A's key as bootstrap
  const b = new Autobase(storeB, a.key, {
    valueEncoding: 'json',
    open,
    apply
  })
  await b.ready()

  console.log('B key:', b4a.toString(b.key, 'hex').slice(0, 16))
  console.log('B local:', b4a.toString(b.local.key, 'hex').slice(0, 16))
  console.log('B writable:', b.writable)

  // Set up Hyperswarm replication
  const swarmA = new Hyperswarm()
  const swarmB = new Hyperswarm()

  swarmA.on('connection', (socket) => {
    console.log('A: peer connected')
    storeA.replicate(socket)
  })

  swarmB.on('connection', (socket) => {
    console.log('B: peer connected')
    storeB.replicate(socket)
  })

  const topic = a.discoveryKey
  await swarmA.join(topic, { server: true, client: true }).flushed()
  await swarmB.join(topic, { server: true, client: true }).flushed()

  console.log('Both joined swarm')

  // Wait for connection
  await new Promise(r => setTimeout(r, 3000))

  console.log('Before add-writer:')
  console.log('A writable:', a.writable)
  console.log('B writable:', b.writable)

  // A adds B as writer
  console.log('A adding B as writer...')
  await a.append({ add: b.local.key.toString('hex') })
  await a.update()

  console.log('After A adds B:')
  console.log('A writable:', a.writable)
  console.log('A activeWriters:', a.activeWriters.map.size)

  // Wait for replication
  await new Promise(r => setTimeout(r, 5000))

  // Update B
  await b.update()

  console.log('After replication and update:')
  console.log('B writable:', b.writable)
  console.log('B activeWriters:', b.activeWriters.map.size)

  // Try to append from B
  if (b.writable) {
    console.log('B appending...')
    await b.append('hello from B')
    console.log('B append success!')
  } else {
    console.log('B is NOT writable - cannot append')
  }

  await swarmA.destroy()
  await swarmB.destroy()
  await a.close()
  await b.close()
  await tmpA.cleanup()
  await tmpB.cleanup()
}

main().catch(console.error)
