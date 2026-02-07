/**
 * Sync Engine v2 for PearSync
 *
 * Multi-writer sync using Autobase + Hyperblobs.
 * All peers are writers - no reader/writer distinction.
 *
 * Based on the working v1 sync.js but using Autobase instead of Hyperdrive.
 */

import Corestore from 'corestore'
import Hyperblobs from 'hyperblobs'
import Hyperswarm from 'hyperswarm'
import Hyperbee from 'hyperbee'
import Localdrive from 'localdrive'
import debounce from 'debounceify'
import b4a from 'b4a'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import { EventEmitter } from 'events'

import { PearSyncAutobase } from './autobase.js'

// Default ignore patterns
export const DEFAULT_IGNORES = [
  'node_modules',
  '.git',
  '.DS_Store',
  'Thumbs.db',
  '*.swp',
  '*.swo',
  '*~',
  '.env',
  '.env.local',
  '.pearsyncignore'
]

export class SyncEngine extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} options.localPath - Path to sync folder
   * @param {string} options.storagePath - Path for hypercore storage
   * @param {string} [options.remoteKey] - Key to join existing workspace (null = create new)
   * @param {string} [options.ownKey] - Key to reopen own workspace
   * @param {boolean} [options.syncDeletes] - Sync deletions (default: true)
   * @param {string[]} [options.ignorePatterns] - Patterns to ignore
   */
  constructor(options = {}) {
    super()

    this.localPath = options.localPath
    this.storagePath = options.storagePath
    this.remoteKey = options.remoteKey || null
    this.ownKey = options.ownKey || null
    this.syncDeletes = options.syncDeletes !== false
    this.ignorePatterns = options.ignorePatterns || DEFAULT_IGNORES

    // Load custom ignore patterns from .pearsyncignore if exists
    this._loadIgnoreFile()

    // Core components
    this.store = null
    this.blobs = null
    this.autobase = null
    this.local = null
    this.swarm = null

    // All peers are writers in v2
    this.isWriter = true

    // Debounced sync functions
    this._syncToRemote = debounce(() => this.syncToRemote())
    this._syncToLocal = debounce(() => this.syncToLocal())

    // State
    this.ready = false
    this.watching = false
    this.peerCount = 0
  }

  /**
   * Load .pearsyncignore file if it exists
   */
  async _loadIgnoreFile() {
    try {
      const ignorePath = path.join(this.localPath, '.pearsyncignore')
      const content = await fs.readFile(ignorePath, 'utf-8')
      const patterns = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))

      this.ignorePatterns = [...DEFAULT_IGNORES, ...patterns]
    } catch (err) {
      // No ignore file, use defaults
    }
  }

  /**
   * Initialize the sync engine
   * @returns {Promise<string>} The workspace key (hex)
   */
  async init() {
    this.emit('status', 'Initializing...')

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

    // Determine bootstrap key
    let bootstrap = null
    if (this.remoteKey) {
      bootstrap = [b4a.from(this.remoteKey, 'hex')]
    } else if (this.ownKey) {
      bootstrap = [b4a.from(this.ownKey, 'hex')]
    }

    // Create autobase
    this.autobase = new PearSyncAutobase(this.store, this.blobs, bootstrap)
    await this.autobase.ready()

    // Create local drive interface
    this.local = new Localdrive(this.localPath)

    // Set up networking
    this.swarm = new Hyperswarm()

    this.swarm.on('connection', async (socket, info) => {
      this.peerCount++
      const peerId = info.publicKey
        ? b4a.toString(info.publicKey, 'hex').slice(0, 8)
        : 'unknown'

      this.emit('peer-join', { peerId, total: this.peerCount })

      // Replicate the corestore
      this.store.replicate(socket)

      socket.on('close', () => {
        this.peerCount--
        this.emit('peer-leave', { peerId, total: this.peerCount })
      })

      socket.on('error', (err) => {
        this.emit('error', { type: 'connection', peerId, error: err.message })
      })

      // Exchange writer keys with peer
      await this._exchangeWriterKeys(socket, info)
    })

    // Join swarm with the topic key
    // Use remoteKey if joining, ownKey if reopening, or new key if creating
    const topicKey = this.remoteKey || this.ownKey || b4a.toString(this.autobase.localWriter, 'hex')
    const topic = b4a.from(topicKey, 'hex')

    const discovery = this.swarm.join(topic, {
      server: true,
      client: true
    })

    await discovery.flushed()
    this.emit('status', 'Connected to network')

    this.ready = true

    // Return the key to share
    return this.remoteKey || this.ownKey || b4a.toString(this.autobase.localWriter, 'hex')
  }

  /**
   * Exchange writer keys with a connected peer
   * 
   * Protocol:
   * 1. Both peers send their writer key as JSON: {"type":"writer-key","key":"<hex>"}
   * 2. When receiving a peer's key, add them as a writer via autobase message
   * 3. This enables bidirectional sync - all peers can write
   */
  async _exchangeWriterKeys(socket, info) {
    try {
      const ourWriterKey = b4a.toString(this.autobase.localWriter, 'hex')
      const peerId = info.publicKey
        ? b4a.toString(info.publicKey, 'hex').slice(0, 8)
        : 'unknown'

      // Track received keys to avoid duplicates
      const receivedKeys = new Set()

      // Buffer for incomplete messages
      let buffer = ''

      // Handle incoming data - look for writer key messages
      const onData = async (data) => {
        buffer += data.toString()
        
        // Try to parse complete JSON messages (newline-delimited)
        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (!line.trim()) continue
          
          try {
            const msg = JSON.parse(line)
            
            if (msg.type === 'writer-key' && msg.key) {
              const peerWriterKey = msg.key
              
              // Skip if we've already processed this key
              if (receivedKeys.has(peerWriterKey)) continue
              receivedKeys.add(peerWriterKey)
              
              // Skip if it's our own key
              if (peerWriterKey === ourWriterKey) continue
              
              this.emit('status', `Adding peer writer: ${peerWriterKey.slice(0, 8)}...`)
              
              // Add the peer as a writer via autobase message
              // This goes through the apply function which handles add-writer ops
              await this.autobase.append({
                type: 'add-writer',
                writerKey: peerWriterKey
              })
              
              // Update view to process the add-writer
              await this.autobase.base.view.update()
              
              // Trigger a sync after adding writer
              setTimeout(() => {
                this._syncToLocal()
              }, 1000)
            }
          } catch (err) {
            // Not valid JSON, ignore
          }
        }
      }

      socket.on('data', onData)

      // Wait for replication to establish
      await new Promise(resolve => setTimeout(resolve, 500))

      // Send our writer key
      const msg = JSON.stringify({ type: 'writer-key', key: ourWriterKey }) + '\n'
      socket.write(msg)
      
      this.emit('status', `Sent writer key to peer ${peerId}`)

    } catch (err) {
      this.emit('error', { type: 'writer-exchange', error: err.message })
    }
  }

  /**
   * Check if a path should be ignored
   */
  shouldIgnore(filePath) {
    const basename = path.basename(filePath)
    const parts = filePath.split(path.sep)

    for (const pattern of this.ignorePatterns) {
      if (basename === pattern) return true
      if (parts.includes(pattern)) return true

      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
        if (regex.test(basename)) return true
      }
    }

    return false
  }

  /**
   * Sync local files to remote (autobase)
   */
  async syncToRemote() {
    if (!this.ready) {
      this.emit('error', { type: 'sync', error: 'Not initialized' })
      return null
    }

    this.emit('sync-start', { direction: 'local→remote' })

    try {
      const stats = { add: 0, change: 0, remove: 0 }

      // Walk local directory and push files
      const localFiles = await this._walkDir(this.localPath)

      for (const filePath of localFiles) {
        const relativePath = path.relative(this.localPath, filePath)

        if (this.shouldIgnore(relativePath)) continue

        try {
          const needsSync = await this._needsSync(relativePath)
          if (needsSync) {
            await this._pushFile(relativePath)
            stats.add++
          }
        } catch (err) {
          this.emit('error', { type: 'push', path: relativePath, error: err.message })
        }
      }

      // Handle deletions - check for files in remote that don't exist locally
      if (this.syncDeletes) {
        const remoteEntries = await this.autobase.list()
        for (const entry of remoteEntries) {
          const localPath = path.join(this.localPath, entry.key)
          try {
            await fs.access(localPath)
          } catch (err) {
            if (err.code === 'ENOENT') {
              await this._pushDelete(entry.key)
              stats.remove++
            }
          }
        }
      }

      this.emit('sync-complete', { direction: 'local→remote', count: stats })
      return stats
    } catch (err) {
      this.emit('error', { type: 'sync', direction: 'local→remote', error: err.message })
      throw err
    }
  }

  /**
   * Sync remote (autobase) to local files
   */
  async syncToLocal() {
    if (!this.ready) {
      this.emit('error', { type: 'sync', error: 'Not initialized' })
      return null
    }

    this.emit('sync-start', { direction: 'remote→local' })

    try {
      // Update autobase view to get latest from peers
      await this.autobase.base.view.update()

      const stats = { add: 0, change: 0, remove: 0 }

      // Get all entries from autobase
      const entries = await this.autobase.list()

      for (const entry of entries) {
        const relativePath = entry.key

        if (this.shouldIgnore(relativePath)) continue

        try {
          const localPath = path.join(this.localPath, relativePath)
          let needsPull = false

          try {
            const localStats = await fs.stat(localPath)
            // File exists, check if remote is newer
            if (entry.value && entry.value.mtime) {
              const localMtime = localStats.mtimeMs
              const remoteMtime = entry.value.mtime
              needsPull = remoteMtime > localMtime + 1000 // 1s tolerance
            }
          } catch (err) {
            if (err.code === 'ENOENT') {
              needsPull = true
            } else {
              throw err
            }
          }

          if (needsPull) {
            await this._pullFile(relativePath)
            stats.add++
          }
        } catch (err) {
          this.emit('error', { type: 'pull', path: relativePath, error: err.message })
        }
      }

      // Handle deletions - files that exist locally but not in remote
      if (this.syncDeletes) {
        const remoteKeys = new Set(entries.map(e => e.key))
        const localFiles = await this._walkDir(this.localPath)

        for (const filePath of localFiles) {
          const relativePath = path.relative(this.localPath, filePath)
          if (this.shouldIgnore(relativePath)) continue

          if (!remoteKeys.has(relativePath)) {
            try {
              await fs.unlink(filePath)
              stats.remove++
            } catch (err) {
              // Ignore deletion errors
            }
          }
        }
      }

      this.emit('sync-complete', { direction: 'remote→local', count: stats })
      return stats
    } catch (err) {
      this.emit('error', { type: 'sync', direction: 'remote→local', error: err.message })
      throw err
    }
  }

  /**
   * Push a single file to autobase
   */
  async _pushFile(relativePath) {
    const fullPath = path.join(this.localPath, relativePath)
    const stats = await fs.stat(fullPath)
    const content = await fs.readFile(fullPath)

    // Store content in hyperblobs
    const blobId = await this.autobase.putBlob(content)

    // Calculate hash
    const hash = crypto.createHash('sha256').update(content).digest('hex')

    // Store metadata in autobase
    await this.autobase.append({
      type: 'put',
      key: relativePath,
      value: {
        blobId,
        size: stats.size,
        mtime: stats.mtimeMs,
        mode: stats.mode,
        hash
      }
    })

    await this.autobase.base.view.update()
  }

  /**
   * Push a deletion to autobase
   */
  async _pushDelete(relativePath) {
    await this.autobase.append({
      type: 'del',
      key: relativePath
    })

    await this.autobase.base.view.update()
  }

  /**
   * Pull a file from autobase to local
   */
  async _pullFile(relativePath) {
    const bee = new Hyperbee(this.autobase.base.view, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })

    const entry = await bee.get(relativePath)
    if (!entry) {
      throw new Error(`File not found: ${relativePath}`)
    }

    const metadata = entry.value

    // Get content from hyperblobs
    const content = await this.autobase.getBlob(metadata.blobId)

    // Write to local filesystem
    const fullPath = path.join(this.localPath, relativePath)
    const parentDir = path.dirname(fullPath)
    await fs.mkdir(parentDir, { recursive: true })
    await fs.writeFile(fullPath, content)

    // Restore permissions and mtime
    if (metadata.mode) {
      await fs.chmod(fullPath, metadata.mode)
    }
    if (metadata.mtime) {
      const mtime = new Date(metadata.mtime)
      await fs.utimes(fullPath, mtime, mtime)
    }
  }

  /**
   * Check if a file needs syncing
   */
  async _needsSync(relativePath) {
    const fullPath = path.join(this.localPath, relativePath)

    let localStats
    try {
      localStats = await fs.stat(fullPath)
    } catch (err) {
      if (err.code === 'ENOENT') {
        return true
      }
      throw err
    }

    // Check remote metadata
    const bee = new Hyperbee(this.autobase.base.view, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })

    const entry = await bee.get(relativePath)
    if (!entry) {
      return true
    }

    const remoteMetadata = entry.value

    // Compare mtime
    if (Math.abs(localStats.mtimeMs - remoteMetadata.mtime) > 1000) {
      // Local is newer, needs sync
      if (localStats.mtimeMs > remoteMetadata.mtime) {
        return true
      }
    }

    // Compare hash
    const content = await fs.readFile(fullPath)
    const hash = crypto.createHash('sha256').update(content).digest('hex')

    return hash !== remoteMetadata.hash
  }

  /**
   * Start watching for local changes
   */
  async startWatching(pollInterval = 3000) {
    if (this.watching) return
    this.watching = true

    this.emit('watch-start')

    // Watch local filesystem
    try {
      const watcher = this.local.watch('/')

      ;(async () => {
        for await (const _ of watcher) {
          if (!this.watching) break
          await this._syncToRemote()
        }
      })().catch(err => {
        this.emit('error', { type: 'watch', error: err.message })
      })

      this._localWatcher = watcher
    } catch (err) {
      // Fallback to polling
      this.emit('status', 'Using polling for file changes')
      this._pollInterval = setInterval(() => {
        if (this.watching) {
          this._syncToRemote()
        }
      }, pollInterval)
    }

    // Periodically check for remote changes
    this._updateInterval = setInterval(async () => {
      try {
        await this.autobase.base.view.update()
        await this._syncToLocal()
      } catch (err) {
        // Ignore periodic sync errors
      }
    }, pollInterval)
  }

  /**
   * Stop watching
   */
  stopWatching() {
    this.watching = false

    if (this._localWatcher) {
      this._localWatcher.destroy?.()
      this._localWatcher = null
    }

    if (this._pollInterval) {
      clearInterval(this._pollInterval)
      this._pollInterval = null
    }

    if (this._updateInterval) {
      clearInterval(this._updateInterval)
      this._updateInterval = null
    }

    this.emit('watch-stop')
  }

  /**
   * Get workspace info
   */
  async getInfo() {
    await this.autobase.base.view.update()

    const entries = await this.autobase.list()
    const totalSize = entries.reduce((sum, e) => sum + (e.value?.size || 0), 0)

    return {
      key: b4a.toString(this.autobase.localWriter, 'hex'),
      version: this.autobase.base.view.length,
      isWriter: true, // All peers are writers in v2
      fileCount: entries.length,
      totalSize,
      peers: this.peerCount
    }
  }

  /**
   * List remote files
   */
  async listRemote(dirPath = '/') {
    const entries = await this.autobase.list()
    return entries.map(e => ({
      path: e.key,
      size: e.value?.size || 0
    }))
  }

  /**
   * Close the engine
   */
  async close() {
    this.emit('status', 'Shutting down...')

    this.stopWatching()

    if (this.swarm) {
      await this.swarm.destroy()
    }

    if (this.autobase) {
      await this.autobase.close()
    }

    if (this.store) {
      await this.store.close()
    }

    this.ready = false
    this.emit('close')
  }

  /**
   * Walk a directory recursively
   */
  async _walkDir(dir) {
    const files = []
    
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })

      for (const entry of entries) {
        if (this.shouldIgnore(entry.name)) continue

        const fullPath = path.join(dir, entry.name)

        if (entry.isDirectory()) {
          const subFiles = await this._walkDir(fullPath)
          files.push(...subFiles)
        } else if (entry.isFile()) {
          files.push(fullPath)
        }
      }
    } catch (err) {
      // Ignore directory read errors
    }

    return files
  }
}
