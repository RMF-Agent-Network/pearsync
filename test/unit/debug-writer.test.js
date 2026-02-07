import test from 'brittle'
import { TestSetup } from '../helpers/setup.js'
import { PearSyncAutobase } from '../../lib/autobase.js'
import b4a from 'b4a'
import { pipeline } from 'streamx'

test('debug: add writer with replication', async (t) => {
  const setup = new TestSetup()
  t.teardown(() => setup.destroy())

  const store1 = await setup.createStore()
  const blobs1 = await setup.createBlobStore(store1)
  const ps1 = new PearSyncAutobase(store1, blobs1)
  await ps1.ready()

  // Create ps2 with ps1's key as bootstrap (like joining a workspace)
  const store2 = await setup.createStore()
  const blobs2 = await setup.createBlobStore(store2)
  const ps2 = new PearSyncAutobase(store2, blobs2, [ps1.localWriter])
  await ps2.ready()

  console.log('ps1 local writer:', b4a.toString(ps1.localWriter, 'hex').slice(0, 16))
  console.log('ps2 local writer:', b4a.toString(ps2.localWriter, 'hex').slice(0, 16))

  // Replicate stores
  console.log('Replicating stores...')
  const s1 = store1.replicate(true)
  const s2 = store2.replicate(false)
  
  // Connect the streams
  s1.pipe(s2).pipe(s1)
  
  // Wait for replication
  await new Promise(resolve => setTimeout(resolve, 1000))
  
  console.log('After replication:')
  console.log('ps1 activeWriters:', ps1.base.activeWriters.map.size)
  console.log('ps2 activeWriters:', ps2.base.activeWriters.map.size)

  // Now try to add ps2 as a writer on ps1
  const ps2KeyHex = b4a.toString(ps2.localWriter, 'hex')
  
  // Check if ps2's core exists in store1 after replication
  const coreInStore1 = store1.get(b4a.from(ps2KeyHex, 'hex'))
  await coreInStore1.ready()
  console.log('ps2 core in store1 after replication - length:', coreInStore1.length)
  
  // Append add-writer message
  console.log('Adding ps2 as writer on ps1...')
  await ps1.base.append({ add: ps2KeyHex })
  await ps1.base.view.update()
  
  // Wait a bit and check
  await new Promise(resolve => setTimeout(resolve, 500))
  
  console.log('ps1 activeWriters after addWriter:', ps1.base.activeWriters.map.size)
  console.log('activeWriters keys:', [...ps1.base.activeWriters.map.keys()].map(k => k.slice(0, 16)))

  const hasWriter = ps1.base.activeWriters.map.has(ps2KeyHex)
  console.log('Has ps2 writer?', hasWriter)

  // Cleanup streams
  s1.destroy()
  s2.destroy()

  t.ok(hasWriter || ps1.base.activeWriters.map.size > 1, 'writer should be added')
})
