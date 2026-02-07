/**
 * Workspace - High-level class for PearSync v2
 *
 * Combines:
 * - Corestore + Hyperblobs + PearSyncAutobase (multi-writer)
 * - Hyperswarm networking
 * - FSWatcher for local file changes
 * - SyncEngine for push/pull operations
 *
 * All peers are writers in v2 - no reader/writer distinction.
 */

import Corestore from 'corestore'
import Hyperblobs from 'hyperblobs'
import Hyperswarm from 'hyperswarm'
import Hyperbee from 'hyperbee'
import b4a from 'b4a'
import path from 'path'
import fs from 'fs/promises'
import { EventEmitter } from 'events'
import debounce from 'debounceify'

import { PearSyncAutobase } from './autobase.js'
import { SyncEngine } from './sync-engine.js'
import { FSWatcher } from './fs-watcher.js'

class Workspace extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} options.localPath - Path to sync folder
   * @param {string} options.storagePath - Path for hypercore storage
   * @param {string} [options.key] - Key to join existing workspace (null = create new)
   * @param {boolean} [options.syncDeletes] - Sync deletions (default: true)
   */
  constructor (options = {}) {
    super()

    this.localPath = options.localPath
    this.storagePath = options.storagePath
    this.key = options.key || null // Bootstrap key (join existing)
    this.syncDeletes = options.syncDeletes !== false

    // Core components
    this.store = null
    this.blobs = null
    this.autobase = null
    this.engine = null
    this.watcher = null
    this.swarm = null

    // State
    this._ready = false
    this._watching = false
    this.peerCount = 0

    // Debounced sync to avoid thrashing
    this._debouncedSync = debounce(() => this._fullSync())
  }

  /**
   * Initialize the workspace
   * @returns {Promise<string>} The workspace key (hex)
   */
  async init () {
    if (this._ready) return this.getKey()

    this.emit('status', 'Initializing workspace...')

    // Ensure directories exist
    await fs.mkdir(this.storagePath, { recursive: true })
    await fs.mkdir(this.localPath, { recursive: true })

    // Create corestore
    this.store = new Corestore(path.join(this.storagePath, 'store'))
    await this.store.ready()

    // Create hyperblobs for file content
    const blobsCore = this.store.get({ name: 'blobs' })
    this.blobs = new Hyperblobs(blobsCore)
    await this.blobs.ready()

    // Create autobase
    const bootstrap = this.key ? [b4a.from(this.key, 'hex')] : null
    this.autobase = new PearSyncAutobase(this.store, this.blobs, bootstrap)
    await this.autobase.ready()

    // Create sync engine
    this.engine = new SyncEngine(this.localPath, this.autobase)
    await this.engine.ready()

    // Set up networking
    await this._setupSwarm()

    this._ready = true
    this.emit('status', 'Workspace ready')

    return this.getKey()
  }

  /**
   * Get the workspace key (hex)
   */
  getKey () {
    if (!this.autobase) return null
    return b4a.toString(this.autobase.base.local.key, 'hex')
  }

  /**
   * Get the discovery key for swarm
   */
  getDiscoveryKey () {
    if (!this.autobase) return null
    // Use the bootstrap key's discovery key if joining, otherwise our local key
    const key = this.key
      ? b4a.from(this.key, 'hex')
      : this.autobase.base.local.key
    return this.store.get(key).discoveryKey
  }

  /**
   * Set up Hyperswarm for peer discovery
   */
  async _setupSwarm () {
    this.swarm = new Hyperswarm()

    this.swarm.on('connection', async (socket, info) => {
      this.peerCount++
      const peerId = info.publicKey
        ? b4a.toString(info.publicKey, 'hex').slice(0, 8)
        : 'unknown'

      this.emit('peer-join', { peerId, total: this.peerCount })

      // Replicate corestore
      this.store.replicate(socket)

      socket.on('close', () => {
        this.peerCount--
        this.emit('peer-leave', { peerId, total: this.peerCount })
      })

      socket.on('error', (err) => {
        this.emit('error', { type: 'connection', peerId, error: err.message })
      })

      // When a peer connects, exchange writer keys and sync
      try {
        await this._handlePeerConnection(socket, info)
      } catch (err) {
        this.emit('error', { type: 'peer-sync', peerId, error: err.message })
      }
    })

    // Join swarm - both server and client for reliable NAT traversal
    const topic = this._getSwarmTopic()
    const discovery = this.swarm.join(topic, {
      server: true,
      client: true
    })

    await discovery.flushed()
    this.emit('status', 'Connected to network')
  }

  /**
   * Get the swarm topic (shared across all peers in this workspace)
   */
  _getSwarmTopic () {
    // Use the bootstrap key if joining, otherwise use our own key
    // This ensures all peers join the same topic
    if (this.key) {
      return b4a.from(this.key, 'hex')
    }
    return this.autobase.base.local.key
  }

  /**
   * Handle a new peer connection
   */
  async _handlePeerConnection (socket, info) {
    // Add the remote peer as a writer so we see their changes
    // For Autobase, we need to exchange writer keys
    
    // Wait a bit for replication to start
    await new Promise(resolve => setTimeout(resolve, 1000))

    // After replication, update our view
    await this.autobase.base.view.update()

    // Trigger a sync
    this._debouncedSync()
  }

  /**
   * Add a remote peer as a writer
   * @param {string} writerKey - Hex key of the remote writer
   */
  async addWriter (writerKey) {
    await this.autobase.addWriter(writerKey)
    this.emit('status', `Added writer: ${writerKey.slice(0, 8)}...`)
  }

  /**
   * Full bidirectional sync
   */
  async _fullSync () {
    this.emit('sync-start', { direction: 'bidirectional' })

    try {
      // 1. Pull remote changes to local
      await this._pullAll()

      // 2. Push local changes to remote
      await this._pushAll()

      this.emit('sync-complete', { direction: 'bidirectional' })
    } catch (err) {
      this.emit('error', { type: 'sync', error: err.message })
    }
  }

  /**
   * Push all local files that need syncing
   */
  async _pushAll () {
    this.emit('sync-start', { direction: 'local→remote' })

    const pushed = { add: 0, change: 0 }

    // Walk local directory
    const files = await this._walkDir(this.localPath)

    for (const filePath of files) {
      const relativePath = path.relative(this.localPath, filePath)
      
      // Skip hidden files and ignored patterns
      if (this._shouldIgnore(relativePath)) continue

      try {
        const needsSync = await this.engine.needsSync(relativePath)
        if (needsSync) {
          await this.engine.pushFile(relativePath)
          pushed.add++
        }
      } catch (err) {
        this.emit('error', { type: 'push', path: relativePath, error: err.message })
      }
    }

    this.emit('sync-complete', { direction: 'local→remote', count: pushed })
    return pushed
  }

  /**
   * Pull all remote files to local
   */
  async _pullAll () {
    this.emit('sync-start', { direction: 'remote→local' })

    const pulled = { add: 0, change: 0, remove: 0 }

    // Get all entries from autobase view
    const entries = await this.autobase.list()

    for (const entry of entries) {
      const relativePath = entry.key

      // Skip ignored patterns
      if (this._shouldIgnore(relativePath)) continue

      try {
        // Check if local file exists and matches
        const localPath = path.join(this.localPath, relativePath)
        let needsPull = false

        try {
          const stats = await fs.stat(localPath)
          // File exists, check if it matches remote
          if (entry.value && entry.value.mtime) {
            // Compare mtime (allow 1s tolerance)
            needsPull = Math.abs(stats.mtimeMs - entry.value.mtime) > 1000
          }
        } catch (err) {
          if (err.code === 'ENOENT') {
            needsPull = true // File doesn't exist locally
          } else {
            throw err
          }
        }

        if (needsPull) {
          await this.engine.pullFile(relativePath)
          pulled.add++
        }
      } catch (err) {
        this.emit('error', { type: 'pull', path: relativePath, error: err.message })
      }
    }

    this.emit('sync-complete', { direction: 'remote→local', count: pulled })
    return pulled
  }

  /**
   * Push a single file to remote
   */
  async pushFile (relativePath) {
    await this.engine.pushFile(relativePath)
  }

  /**
   * Pull a single file from remote
   */
  async pullFile (relativePath) {
    await this.engine.pullFile(relativePath)
  }

  /**
   * Start watching for local file changes
   */
  async startWatching () {
    if (this._watching) return

    this.watcher = new FSWatcher(this.localPath)
    await this.watcher.ready()

    this.watcher.on('change', async ({ type, path: relativePath }) => {
      this.emit('local-change', { type, path: relativePath })

      try {
        if (type === 'unlink' || type === 'unlinkDir') {
          if (this.syncDeletes) {
            await this.engine.pushDelete(relativePath)
          }
        } else if (type === 'add' || type === 'change') {
          await this.engine.pushFile(relativePath)
        }
      } catch (err) {
        this.emit('error', { type: 'watch-sync', path: relativePath, error: err.message })
      }
    })

    this.watcher.on('error', (err) => {
      this.emit('error', { type: 'watcher', error: err.message })
    })

    this._watching = true
    this.emit('watch-start')

    // Also set up periodic sync for remote changes
    this._syncInterval = setInterval(async () => {
      try {
        await this.autobase.base.view.update()
        await this._pullAll()
      } catch (err) {
        // Ignore periodic sync errors
      }
    }, 5000)
  }

  /**
   * Stop watching
   */
  async stopWatching () {
    if (!this._watching) return

    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }

    if (this._syncInterval) {
      clearInterval(this._syncInterval)
      this._syncInterval = null
    }

    this._watching = false
    this.emit('watch-stop')
  }

  /**
   * Get workspace info
   */
  async getInfo () {
    const entries = await this.autobase.list()
    const totalSize = entries.reduce((sum, e) => sum + (e.value?.size || 0), 0)

    return {
      key: this.getKey(),
      fileCount: entries.length,
      totalSize,
      peers: this.peerCount,
      watching: this._watching
    }
  }

  /**
   * Close the workspace
   */
  async close () {
    this.emit('status', 'Closing workspace...')

    await this.stopWatching()

    if (this.swarm) {
      await this.swarm.destroy()
    }

    if (this.autobase) {
      await this.autobase.close()
    }

    if (this.engine) {
      await this.engine.close()
    }

    if (this.store) {
      await this.store.close()
    }

    this._ready = false
    this.emit('close')
  }

  /**
   * Walk a directory recursively
   */
  async _walkDir (dir) {
    const files = []
    const entries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        // Skip ignored directories
        if (!this._shouldIgnore(entry.name)) {
          const subFiles = await this._walkDir(fullPath)
          files.push(...subFiles)
        }
      } else if (entry.isFile()) {
        files.push(fullPath)
      }
    }

    return files
  }

  /**
   * Check if a path should be ignored
   */
  _shouldIgnore (filePath) {
    const ignored = [
      'node_modules',
      '.git',
      '.DS_Store',
      'Thumbs.db',
      '.pearsyncignore'
    ]

    const parts = filePath.split(path.sep)
    return parts.some(part => ignored.includes(part))
  }
}

export { Workspace }
