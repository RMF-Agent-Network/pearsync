import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'

const topic = b4a.from('c7a90ec2065e9bf21fa5581470445e23c2ce3705dd2334de6c1844e531cff045', 'hex')

console.log('Creating swarm...')
const swarm = new Hyperswarm()

// Wait for DHT to be ready
await swarm.dht.ready()
console.log('DHT ready!')
console.log('DHT bootstrapped:', swarm.dht.bootstrapped)
console.log('DHT address:', swarm.dht.host, swarm.dht.port)

swarm.on('connection', (conn, info) => {
  console.log('🎉 CONNECTION:', b4a.toString(info.publicKey, 'hex').slice(0, 8))
})

console.log('\nJoining topic...')
const discovery = swarm.join(topic, { server: true, client: true })

// Wait for flush
await discovery.flushed()
console.log('Flushed! Announced to DHT')

// Now call swarm.flush() to ensure connections
console.log('Waiting for swarm.flush()...')
await swarm.flush()
console.log('Swarm flushed!')

console.log('Connections:', swarm.connections.size)
console.log('Peers:', swarm.peers.size)
console.log('Connecting:', swarm.connecting)

// Wait more
for (let i = 0; i < 6; i++) {
  await new Promise(r => setTimeout(r, 10000))
  console.log(`[${(i+1)*10}s] conn=${swarm.connections.size} peers=${swarm.peers.size}`)
}

await swarm.destroy()
