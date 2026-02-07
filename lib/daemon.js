import net from 'net'
import fs from 'fs/promises'
import path from 'path'
import goodbye from 'graceful-goodbye'
import { SyncEngine } from './sync-engine.js'

export class Daemon {
  constructor(socketPath) {
    this.socketPath = socketPath
    this.server = null
    this.workspaces = new Map() // path -> { engine, metadata }
    this.running = false
    this._setupGracefulShutdown()
  }

  _setupGracefulShutdown() {
    goodbye(() => this.stop(), 1000)
  }

  async start() {
    if (this.running) {
      throw new Error('Daemon already running')
    }

    // Ensure socket directory exists
    const socketDir = path.dirname(this.socketPath)
    await fs.mkdir(socketDir, { recursive: true })

    // Clean up old socket if it exists
    try {
      await fs.unlink(this.socketPath)
    } catch (err) {
      // Ignore if socket doesn't exist
    }

    this.server = net.createServer((socket) => {
      this._handleConnection(socket)
    })

    return new Promise((resolve, reject) => {
      this.server.listen(this.socketPath, (err) => {
        if (err) {
          reject(err)
        } else {
          this.running = true
          resolve()
        }
      })

      this.server.on('error', (err) => {
        console.error('Daemon server error:', err)
      })
    })
  }

  async stop() {
    if (!this.running) {
      return
    }

    // Stop all workspace sync engines
    for (const [workspacePath, { engine }] of this.workspaces) {
      try {
        await engine.close()
      } catch (err) {
        console.error(`Error closing workspace ${workspacePath}:`, err)
      }
    }
    this.workspaces.clear()

    // Close server
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(async () => {
          this.running = false

          // Remove socket file
          try {
            await fs.unlink(this.socketPath)
          } catch (err) {
            // Ignore errors removing socket
          }

          resolve()
        })
      })
    }
  }

  isRunning() {
    return this.running
  }

  _handleConnection(socket) {
    let buffer = ''

    socket.on('data', async (data) => {
      buffer += data.toString()

      // Check if we have a complete JSON message (newline-delimited)
      const lines = buffer.split('\n')
      buffer = lines.pop() // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue

        try {
          const message = JSON.parse(line)
          const response = await this._handleMessage(message)
          socket.write(JSON.stringify(response) + '\n')
        } catch (err) {
          socket.write(JSON.stringify({
            error: `Invalid message: ${err.message}`
          }) + '\n')
        }
      }
    })

    socket.on('error', (err) => {
      console.error('Socket error:', err)
    })
  }

  async _handleMessage(message) {
    const { command } = message

    try {
      switch (command) {
        case 'status':
          return this._handleStatus()

        case 'watch':
          return await this._handleWatch(message)

        case 'unwatch':
          return await this._handleUnwatch(message)

        case 'list':
          return this._handleList()

        case 'shutdown':
          // Shutdown daemon gracefully
          setImmediate(() => this.stop())
          return { success: true, message: 'Shutting down' }

        default:
          return { error: `Unknown command: ${command}` }
      }
    } catch (err) {
      return { error: err.message }
    }
  }

  _handleStatus() {
    return {
      running: this.running,
      workspaces: Array.from(this.workspaces.entries()).map(([path, { metadata }]) => ({
        path,
        ...metadata
      })),
      socketPath: this.socketPath
    }
  }

  async _handleWatch(message) {
    const { workspace } = message

    if (!workspace) {
      return { error: 'workspace path required' }
    }

    // Check if already watching
    if (this.workspaces.has(workspace)) {
      return {
        success: true,
        workspace,
        message: 'Already watching workspace'
      }
    }

    try {
      // Verify workspace exists
      const stats = await fs.stat(workspace)
      if (!stats.isDirectory()) {
        return { error: 'Workspace must be a directory' }
      }

      // Create sync engine for workspace
      const engine = new SyncEngine(workspace)
      await engine.ready()

      // Store workspace
      this.workspaces.set(workspace, {
        engine,
        metadata: {
          startedAt: new Date().toISOString(),
          status: 'active'
        }
      })

      return {
        success: true,
        workspace,
        message: 'Workspace added successfully'
      }
    } catch (err) {
      return {
        error: `Failed to watch workspace: ${err.message}`
      }
    }
  }

  async _handleUnwatch(message) {
    const { workspace } = message

    if (!workspace) {
      return { error: 'workspace path required' }
    }

    const entry = this.workspaces.get(workspace)
    if (!entry) {
      return { error: 'Workspace not found' }
    }

    try {
      await entry.engine.close()
      this.workspaces.delete(workspace)

      return {
        success: true,
        workspace,
        message: 'Workspace removed successfully'
      }
    } catch (err) {
      return {
        error: `Failed to unwatch workspace: ${err.message}`
      }
    }
  }

  _handleList() {
    return {
      workspaces: Array.from(this.workspaces.entries()).map(([path, { metadata }]) => ({
        path,
        ...metadata
      }))
    }
  }
}
