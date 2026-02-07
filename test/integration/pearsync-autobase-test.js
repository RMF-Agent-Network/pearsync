/**
 * Test PearSyncAutobase specifically over Hyperswarm
 */
import test from 'brittle'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import tmp from 'tmp-promise'
import { setTimeout as sleep } from 'timers/promises'
import { PearSyncAutobase } from '../../lib/autobase.js'

test('PearSyncAutobase: B becomes writable via Hyperswarm', async (t) => {
  const tmpA = await tmp.dir({ unsafeCleanup: true })
  const tmpB = await tmp.dir({ unsafeCleanup: true })
  
  const storeA = new Corestore(tmpA.path)
  const storeB = new Corestore(tmpB.path)
  await storeA.ready()
  await storeB.ready()

  // A creates autobase (no bootstrap = creator)
  const autobaseA = new PearSyncAutobase(storeA, null, null)
  await autobaseA.ready()
  console.log('A key:', b4a.toString(autobaseA.base.key, 'hex').slice(0, 16))
  console.log('A writable:', autobaseA.base.writable)
  t.ok(autobaseA.base.writable, 'A should be writable')

  // B joins with A's key
  const autobaseB = new PearSyncAutobase(storeB, null, [autobaseA.base.key])
  await autobaseB.ready()
  console.log('B local:', b4a.toString(autobaseB.localWriter, 'hex').slice(0, 16))
  console.log('B writable:', autobaseB.base.writable)

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
    console.log('A: connection', info.client ? '(client)' : '(server)')
    storeA.replicate(socket)
  })

  swarmB.on('connection', (socket, info) => {
    console.log('B: connection', info.client ? '(client)' : '(server)')
    storeB.replicate(socket)
  })

  // Join using autobase discovery key
  const topic = autobaseA.base.discoveryKey
  console.log('Topic:', b4a.toString(topic, 'hex').slice(0, 16))

  const discA = swarmA.join(topic, { server: true, client: true })
  const discB = swarmB.join(topic, { server: true, client: true })
  await discA.flushed()
  await discB.flushed()
  console.log('Swarms flushed')

  // Wait for connections with timeout
  console.log('Waiting for connections...')
  for (let i = 0; i < 10; i++) {
    await sleep(500)
    const aConns = swarmA.connections.size
    const bConns = swarmB.connections.size
    console.log(`[${i+1}] A conns: ${aConns}, B conns: ${bConns}`)
    if (aConns > 0 && bConns > 0) {
      console.log('Both connected!')
      break
    }
  }

  // A adds B as writer
  const bKey = b4a.toString(autobaseB.localWriter, 'hex')
  console.log('A adding B:', bKey.slice(0, 16))
  
  await autobaseA.append({ type: 'add-writer', writerKey: bKey })
  await autobaseA.base.update()
  console.log('A.local.length:', autobaseA.base.local.length)
  console.log('A.view.length:', autobaseA.base.view.length)

  // Poll B for writer status
  for (let i = 0; i < 15; i++) {
    await sleep(500)
    await autobaseB.base.update()
    console.log(`[${i+1}] B.view.length:`, autobaseB.base.view.length, 
                'B.writable:', autobaseB.base.writable)
    if (autobaseB.base.writable) break
  }

  t.ok(autobaseB.base.writable, 'B should become writable')
})
