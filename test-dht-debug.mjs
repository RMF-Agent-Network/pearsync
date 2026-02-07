import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'

const topic = b4a.from('c7a90ec2065e9bf21fa5581470445e23c2ce3705dd2334de6c1844e531cff045', 'hex')

console.log('Creating swarm...')
const swarm = new Hyperswarm()

swarm.on('connection', (conn, info) => {
  const peerId = b4a.toString(info.publicKey, 'hex').slice(0, 8)
  console.log('🎉 GOT CONNECTION!', peerId)
})

console.log('Joining topic as client+server...')
const discovery = swarm.join(topic, { server: true, client: true })

console.log('Waiting for flushed...')
await discovery.flushed()
console.log('Flushed! DHT bootstrapped:', swarm.dht.bootstrapped)

// Poll for connections
for (let i = 0; i < 12; i++) {
  await new Promise(r => setTimeout(r, 5000))
  console.log(`[${(i+1)*5}s] connections: ${swarm.connections.size}, peers: ${swarm.peers.size}`)
}

await swarm.destroy()
console.log('Done')
