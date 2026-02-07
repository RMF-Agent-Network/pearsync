import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'

const topic = b4a.from('c7a90ec2065e9bf21fa5581470445e23c2ce3705dd2334de6c1844e531cff045', 'hex')
const swarm = new Hyperswarm()

swarm.on('connection', (conn, info) => {
  console.log('✅ CONNECTED:', b4a.toString(info.publicKey, 'hex'))
})

const discovery = swarm.join(topic, { server: true, client: true })
await discovery.flushed()
await swarm.flush()

console.log('Found peers:')
for (const [key, peer] of swarm.peers) {
  console.log('  Key:', key)
}

// Try to explicitly connect to each peer
console.log('\nTrying direct joinPeer...')
for (const [key, peer] of swarm.peers) {
  const pubkey = b4a.from(key, 'hex')
  console.log('Attempting:', key.slice(0, 16))
  swarm.joinPeer(pubkey)
}

// Wait for connections
await new Promise(r => setTimeout(r, 30000))
console.log('\nFinal connections:', swarm.connections.size)

await swarm.destroy()
