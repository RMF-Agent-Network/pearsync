/**
 * Test: Is Hyperswarm actually connecting?
 */
import test from 'brittle'
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import tmp from 'tmp-promise'
import { setTimeout as sleep } from 'timers/promises'

test('swarm connection test', async (t) => {
  const tmpA = await tmp.dir({ unsafeCleanup: true })
  const tmpB = await tmp.dir({ unsafeCleanup: true })
  
  const storeA = new Corestore(tmpA.path)
  const storeB = new Corestore(tmpB.path)
  await storeA.ready()
  await storeB.ready()

  const swarmA = new Hyperswarm()
  const swarmB = new Hyperswarm()
  
  let aConnections = 0
  let bConnections = 0

  swarmA.on('connection', (socket, info) => {
    aConnections++
    console.log('>>> A GOT CONNECTION <<<', aConnections)
    const repl = storeA.replicate(socket)
    repl.on('error', (e) => console.log('A repl error:', e.message))
  })

  swarmB.on('connection', (socket, info) => {
    bConnections++
    console.log('>>> B GOT CONNECTION <<<', bConnections)
    const repl = storeB.replicate(socket)
    repl.on('error', (e) => console.log('B repl error:', e.message))
  })

  // Use a random topic
  const topic = Buffer.alloc(32)
  topic.fill('pearsync-test-topic-12345')
  
  console.log('Topic:', b4a.toString(topic, 'hex').slice(0, 16))
  console.log('Joining swarms...')

  const discA = swarmA.join(topic, { server: true, client: true })
  const discB = swarmB.join(topic, { server: true, client: true })

  await discA.flushed()
  console.log('A flushed')
  await discB.flushed()
  console.log('B flushed')

  console.log('Waiting 5s for connection...')
  await sleep(5000)

  console.log('A connections:', aConnections)
  console.log('B connections:', bConnections)

  t.ok(aConnections > 0 && bConnections > 0, 'Both peers should connect')

  await swarmA.destroy()
  await swarmB.destroy()
  await storeA.close()
  await storeB.close()
  await tmpA.cleanup()
  await tmpB.cleanup()
})
