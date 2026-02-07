import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import path from 'path'
import os from 'os'
import fs from 'fs/promises'

const key = '72201be64cbe16d5ba7534ded18e8bc4d2177fad339069069a0293a68b6123e7'
const storagePath = path.join(os.homedir(), '.local/share/pearsync/stores', key, 'store')

console.log('Storage path:', storagePath)

// Check if store exists
try {
  await fs.access(storagePath)
  console.log('Store exists')
} catch {
  console.log('Store does NOT exist - creating fresh')
  await fs.mkdir(storagePath, { recursive: true })
}

const store = new Corestore(storagePath)
const keyBuffer = b4a.from(key, 'hex')
const drive = new Hyperdrive(store, keyBuffer)
await drive.ready()

console.log('Drive key:', b4a.toString(drive.key, 'hex').slice(0, 16) + '...')
console.log('Discovery key:', b4a.toString(drive.discoveryKey, 'hex').slice(0, 16) + '...')
console.log('Full discovery:', b4a.toString(drive.discoveryKey, 'hex'))

// Now test swarm with both server and client
const swarm = new Hyperswarm()
swarm.on('connection', (c, i) => {
  console.log('🎉 CONNECTED:', b4a.toString(i.publicKey, 'hex').slice(0,8))
  store.replicate(c)
})

const disc = swarm.join(drive.discoveryKey, { server: true, client: true })
await disc.flushed()
console.log('Announced to DHT')

await swarm.flush()
console.log('Flushed, peers:', swarm.peers.size)

for (let i = 0; i < 6; i++) {
  await new Promise(r => setTimeout(r, 10000))
  console.log('[' + (i+1)*10 + 's] conn:', swarm.connections.size, 'peers:', swarm.peers.size)
}

await swarm.destroy()
await store.close()
