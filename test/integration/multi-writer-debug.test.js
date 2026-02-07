/**
 * Deep debug: trace every step of writer propagation
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

test('debug: trace writer propagation step by step', async (t) => {
  const tmpA = await tmp.dir({ unsafeCleanup: true })
  const tmpB = await tmp.dir({ unsafeCleanup: true })
  
  const storeA = new Corestore(tmpA.path)
  const storeB = new Corestore(tmpB.path)
  await storeA.ready()
  await storeB.ready()

  let applyCallsA = 0
  let applyCallsB = 0

  async function applyA(nodes, view, base) {
    for (const node of nodes) {
      applyCallsA++
      console.log(`[A apply #${applyCallsA}] op:`, JSON.stringify(node.value))
      
      if (node.value?.type === 'add-writer') {
        const key = b4a.from(node.value.writerKey, 'hex')
        console.log('[A apply] calling base.addWriter for:', node.value.writerKey.slice(0, 16))
        await base.addWriter(key, { indexer: true })
        console.log('[A apply] addWriter completed')
      }
      await view.append(node.value)
    }
  }

  async function applyB(nodes, view, base) {
    for (const node of nodes) {
      applyCallsB++
      console.log(`[B apply #${applyCallsB}] op:`, JSON.stringify(node.value))
      
      if (node.value?.type === 'add-writer') {
        const key = b4a.from(node.value.writerKey, 'hex')
        console.log('[B apply] calling base.addWriter for:', node.value.writerKey.slice(0, 16))
        await base.addWriter(key, { indexer: true })
        console.log('[B apply] addWriter completed, base.writable:', base.writable)
      }
      await view.append(node.value)
    }
  }

  // A creates autobase
  const a = new Autobase(storeA, { valueEncoding: 'json', open, apply: applyA })
  await a.ready()
  
  console.log('=== SETUP ===')
  console.log('A key:', b4a.toString(a.key, 'hex').slice(0, 16))
  console.log('A local key:', b4a.toString(a.local.key, 'hex').slice(0, 16))
  console.log('A writable:', a.writable)

  // B joins with A's key
  const b = new Autobase(storeB, a.key, { valueEncoding: 'json', open, apply: applyB })
  await b.ready()
  
  console.log('B local key:', b4a.toString(b.local.key, 'hex').slice(0, 16))
  console.log('B writable:', b.writable)

  // Set up swarms
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

  swarmA.on('connection', (socket) => {
    console.log('[swarm] A got connection')
    storeA.replicate(socket)
  })

  swarmB.on('connection', (socket) => {
    console.log('[swarm] B got connection')
    storeB.replicate(socket)
  })

  const topic = a.discoveryKey
  const discA = swarmA.join(topic, { server: true, client: true })
  const discB = swarmB.join(topic, { server: true, client: true })
  await discA.flushed()
  await discB.flushed()
  console.log('=== SWARMS FLUSHED ===')

  await sleep(2000)
  console.log('=== AFTER 2s WAIT ===')

  // Check A's local core
  console.log('A.local.length:', a.local.length)
  console.log('B.local.length:', b.local.length)

  // A adds B as writer
  const bLocalKey = b4a.toString(b.local.key, 'hex')
  console.log('=== A ADDING B AS WRITER ===')
  console.log('B local key to add:', bLocalKey.slice(0, 16))
  
  await a.append({ type: 'add-writer', writerKey: bLocalKey })
  console.log('A.local.length after append:', a.local.length)
  
  await a.update()
  console.log('A.view.length after update:', a.view.length)
  console.log('A applyCallsA so far:', applyCallsA)

  // Now let's try to get B to see the message
  console.log('=== WAITING FOR B TO REPLICATE ===')
  
  for (let i = 0; i < 10; i++) {
    await sleep(1000)
    
    // Force B to update
    await b.update()
    
    console.log(`[${i+1}] B.view.length:`, b.view.length, 
                'B.writable:', b.writable,
                'applyCallsB:', applyCallsB)
    
    if (b.writable) {
      console.log('SUCCESS: B is writable!')
      break
    }
  }

  // Check what cores B knows about
  console.log('=== B STATE ===')
  console.log('B.activeWriters size:', b.activeWriters?.size || 'N/A')
  
  t.ok(b.writable, 'B should become writable')
})
