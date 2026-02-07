import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
const topic = b4a.from(process.argv[2], 'hex')
console.log('LOCAL: Starting with topic', process.argv[2].slice(0,8))
const swarm = new Hyperswarm()
swarm.on('connection', (conn, info) => {
  console.log('LOCAL ✅ CONNECTED:', b4a.toString(info.publicKey, 'hex').slice(0,8))
  conn.on('data', d => console.log('LOCAL received:', d.toString()))
})
const d = swarm.join(topic, { server: true, client: true })
await d.flushed()
console.log('LOCAL: Announced, waiting...')
for (let i = 0; i < 12; i++) {
  await new Promise(r => setTimeout(r, 5000))
  console.log('LOCAL [' + (i+1)*5 + 's] conn=' + swarm.connections.size + ' peers=' + swarm.peers.size)
}
await swarm.destroy()
