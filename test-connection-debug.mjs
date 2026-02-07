import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'

const topic = b4a.from('c7a90ec2065e9bf21fa5581470445e23c2ce3705dd2334de6c1844e531cff045', 'hex')

const swarm = new Hyperswarm()

// Listen for all events
swarm.on('connection', (conn, info) => {
  console.log('✅ CONNECTION:', b4a.toString(info.publicKey, 'hex').slice(0, 8))
})

swarm.on('update', () => {
  console.log('UPDATE: conn=' + swarm.connections.size + ' peers=' + swarm.peers.size + ' connecting=' + swarm.connecting)
})

// Check for banned peers
swarm.on('ban', (peerInfo, err) => {
  console.log('❌ BANNED:', b4a.toString(peerInfo.publicKey, 'hex').slice(0, 8), err.message)
})

await swarm.dht.ready()
console.log('DHT ready, port:', swarm.dht.port)

const discovery = swarm.join(topic, { server: true, client: true })
await discovery.flushed()
console.log('Announced')

await swarm.flush()
console.log('Flushed')

// Check peers and their status
console.log('\nPeer details:')
for (const [key, peer] of swarm.peers) {
  console.log('  Peer:', key.slice(0, 16), 'prioritized:', peer.prioritized, 'topics:', peer.topics.length)
}

// Wait and watch
for (let i = 0; i < 4; i++) {
  await new Promise(r => setTimeout(r, 15000))
  console.log(`[${(i+1)*15}s] checking peers...`)
  for (const [key, peer] of swarm.peers) {
    console.log('  ', key.slice(0, 16))
  }
}

await swarm.destroy()
