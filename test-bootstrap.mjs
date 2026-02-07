import DHT from 'hyperdht'

console.log('Creating DHT node...')
const dht = new DHT()

console.log('Waiting for ready...')
await dht.ready()

console.log('DHT ready!')
console.log('Bootstrapped:', dht.bootstrapped)
console.log('Address:', dht.host, dht.port)

// Try to ping bootstrap nodes
console.log('\nTrying to reach bootstrap nodes...')
try {
  const nodes = await dht.findNode(dht.defaultKeyPair.publicKey)
  console.log('Found nodes:', nodes.length)
} catch (err) {
  console.log('Error finding nodes:', err.message)
}

await dht.destroy()
