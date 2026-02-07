import Hyperswarm from 'hyperswarm'
import DHT from 'hyperdht'
import b4a from 'b4a'

const topic = b4a.from('c7a90ec2065e9bf21fa5581470445e23c2ce3705dd2334de6c1844e531cff045', 'hex')

// Create DHT with explicit port
const dht = new DHT({ port: 49737 })
await dht.ready()
console.log('DHT on port:', dht.port)
console.log('DHT bootstrapped:', dht.bootstrapped)

const swarm = new Hyperswarm({ dht })

swarm.on('connection', (conn, info) => {
  console.log('✅ CONNECTION:', b4a.toString(info.publicKey, 'hex').slice(0, 8))
})

await swarm.listen()
console.log('Swarm listening')

const discovery = swarm.join(topic, { server: true, client: true })
await discovery.flushed()
console.log('Flushed')

await swarm.flush()
console.log('Connections:', swarm.connections.size)
console.log('Peers:', swarm.peers.size)

for (let i = 0; i < 6; i++) {
  await new Promise(r => setTimeout(r, 10000))
  console.log(`[${(i+1)*10}s] conn=${swarm.connections.size}`)
}

await swarm.destroy()
