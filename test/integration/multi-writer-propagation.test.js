/**
 * Test: Multi-writer propagation
 * Verifies that when A adds B as writer, B actually becomes writable
 */
import test from 'brittle'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import tmp from 'tmp-promise'
import { setTimeout as sleep } from 'timers/promises'
import { PearSyncAutobase } from '../../lib/autobase.js'

test('multi-writer: B becomes writable after A adds them', async (t) => {
  const tmpA = await tmp.dir({ unsafeCleanup: true })
  const tmpB = await tmp.dir({ unsafeCleanup: true })
  
  const storeA = new Corestore(tmpA.path)
  const storeB = new Corestore(tmpB.path)
  await storeA.ready()
  await storeB.ready()

  // A creates autobase (bootstrap writer)
  const autobaseA = new PearSyncAutobase(storeA, null, null)
  await autobaseA.ready()
  
  console.log('A key:', b4a.toString(autobaseA.base.key, 'hex').slice(0, 16))
  console.log('A local writer:', b4a.toString(autobaseA.localWriter, 'hex').slice(0, 16))
  console.log('A writable:', autobaseA.base.writable)
  t.ok(autobaseA.base.writable, 'A should be writable (bootstrap)')

  // B joins with A's key
  const autobaseB = new PearSyncAutobase(storeB, null, [autobaseA.base.key])
  await autobaseB.ready()
  
  console.log('B local writer:', b4a.toString(autobaseB.localWriter, 'hex').slice(0, 16))
  console.log('B writable initially:', autobaseB.base.writable)
  t.not(autobaseB.base.writable, 'B should NOT be writable initially')

  // Set up swarms
  const swarmA = new Hyperswarm()
  const swarmB = new Hyperswarm()
  
  t.teardown(async () => {
    await swarmA.destroy()
    await swarmB.destroy()
    await autobaseA.close()
    await autobaseB.close()
    await storeA.close()
    await storeB.close()
    await tmpA.cleanup()
    await tmpB.cleanup()
  })

  swarmA.on('connection', (socket, info) => {
    console.log('>>> A: peer connected <<<', info.client ? '(client)' : '(server)')
    storeA.replicate(socket)
  })

  swarmB.on('connection', (socket, info) => {
    console.log('>>> B: peer connected <<<', info.client ? '(client)' : '(server)')
    storeB.replicate(socket)
  })

  // Join same topic
  const topic = autobaseA.base.discoveryKey
  const discA = swarmA.join(topic, { server: true, client: true })
  const discB = swarmB.join(topic, { server: true, client: true })
  await discA.flushed()
  await discB.flushed()
  console.log('Swarms connected')

  // Wait for actual connections (not just DHT flush)
  console.log('Waiting for connections...')
  for (let i = 0; i < 15; i++) {
    await sleep(500)
    const aConns = swarmA.connections.size
    const bConns = swarmB.connections.size
    if (aConns > 0 && bConns > 0) {
      console.log(`Connected after ${(i+1) * 500}ms: A=${aConns}, B=${bConns}`)
      break
    }
    if (i === 14) {
      console.log('Warning: No connections after 7.5s')
    }
  }

  // A adds B as writer
  const bWriterKey = b4a.toString(autobaseB.localWriter, 'hex')
  console.log('A adding B as writer:', bWriterKey.slice(0, 16))
  
  await autobaseA.append({
    type: 'add-writer',
    writerKey: bWriterKey
  })
  await autobaseA.base.update()
  console.log('A writable after add:', autobaseA.base.writable)
  console.log('A.local.length:', autobaseA.base.local.length)
  console.log('A.view.length:', autobaseA.base.view.length)

  // Wait for replication and poll B
  let bWritable = false
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    await autobaseB.base.update()
    console.log(`[${i + 1}] B.view.length:`, autobaseB.base.view.length, 'B.writable:', autobaseB.base.writable)
    if (autobaseB.base.writable) {
      bWritable = true
      break
    }
  }

  t.ok(bWritable, 'B should become writable after A adds them')

  if (bWritable) {
    // B should be able to append
    await autobaseB.append({ type: 'put', key: 'test.txt', value: { content: 'hello' } })
    console.log('B successfully appended!')
    t.pass('B can append after becoming writable')
  }
})
