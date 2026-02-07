import net from 'net'

export class DaemonClient {
  constructor(socketPath) {
    this.socketPath = socketPath
  }

  async send(message, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath)
      let buffer = ''
      let timer

      // Set timeout
      timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('Request timeout'))
      }, timeout)

      socket.on('connect', () => {
        // Send message as newline-delimited JSON
        socket.write(JSON.stringify(message) + '\n')
      })

      socket.on('data', (data) => {
        buffer += data.toString()

        // Check for complete response (newline-delimited)
        const lines = buffer.split('\n')

        // If we have at least one complete line, process it
        if (lines.length > 1) {
          clearTimeout(timer)

          try {
            const response = JSON.parse(lines[0])
            socket.end()
            resolve(response)
          } catch (err) {
            socket.destroy()
            reject(new Error(`Invalid response: ${err.message}`))
          }
        }
      })

      socket.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })

      socket.on('timeout', () => {
        clearTimeout(timer)
        socket.destroy()
        reject(new Error('Socket timeout'))
      })
    })
  }

  async status() {
    return this.send({ command: 'status' })
  }

  async watch(workspace) {
    return this.send({ command: 'watch', workspace })
  }

  async unwatch(workspace) {
    return this.send({ command: 'unwatch', workspace })
  }

  async list() {
    return this.send({ command: 'list' })
  }

  static async isRunning(socketPath) {
    try {
      const client = new DaemonClient(socketPath)
      await client.status()
      return true
    } catch (err) {
      return false
    }
  }
}
