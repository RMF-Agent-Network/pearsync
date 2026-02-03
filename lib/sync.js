/**
 * Sync Engine for PearSync
 * 
 * Core workspace sync logic using Holepunch primitives:
 * - Hyperdrive: P2P filesystem (stores files as hypercore)
 * - Localdrive: Local filesystem interface
 * - Corestore: Manages hypercores efficiently
 * - Hyperswarm: Peer discovery and connection
 */

import Hyperdrive from 'hyperdrive'
import Localdrive from 'localdrive'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import debounce from 'debounceify'
import b4a from 'b4a'
import path from 'path'
import fs from 'fs/promises'
import { EventEmitter } from 'events'

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
   * @param {string} [options.remoteKey] - Key to join as reader (null = create new or use ownKey)
   * @param {string} [options.ownKey] - Key to reopen as writer (for existing workspaces we own)
   * @param {boolean} [options.syncDeletes] - Sync deletions (default: true)
   * @param {string[]} [options.ignorePatterns] - Patterns to ignore
   */
  constructor(options = {}) {
    super()
    
    this.localPath = options.localPath
    this.storagePath = options.storagePath
    this.remoteKey = options.remoteKey || null
    this.ownKey = options.ownKey || null  // For reopening our own workspaces
    this.syncDeletes = options.syncDeletes !== false
    this.ignorePatterns = options.ignorePatterns || DEFAULT_IGNORES
    
    // Load custom ignore patterns from .pearsyncignore if exists
    this._loadIgnoreFile()
    
    this.store = null
    this.drive = null
    this.local = null
    this.swarm = null
    this.isWriter = !this.remoteKey  // Writer if no remoteKey (even if ownKey is set)
    
    // Debounced sync functions to avoid thrashing
    this._syncToRemote = debounce(() => this.syncToRemote())
    this._syncToLocal = debounce(() => this.syncToLocal())
    
    // State
    this.ready = false
    this.watching = false
    this.peerCount = 0
    this._reconnectAttempts = 0
  }
  
  /**
   * Load .pearsyncignore file if it exists
   */
  async _loadIgnoreFile() {
    try {
      const ignorePath = path.join(this.localPath, '.pearsyncignore')
      const content = await fs.readFile(ignorePath, 'utf-8')
      const patterns = content.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
      
      this.ignorePatterns = [...DEFAULT_IGNORES, ...patterns]
    } catch (err) {
      // No ignore file, use defaults
    }
  }
  
  /**
   * Initialize the sync engine
   * @returns {Promise<string>} The drive's public key (hex)
   */
  async init() {
    this.emit('status', 'Initializing...')
    
    // Ensure storage directory exists
    await fs.mkdir(this.storagePath, { recursive: true })
    await fs.mkdir(this.localPath, { recursive: true })
    
    // Create corestore for managing hypercores
    this.store = new Corestore(path.join(this.storagePath, 'store'))
    
    // Create or open hyperdrive
    if (this.remoteKey) {
      // Joining existing drive (read-only)
      const keyBuffer = b4a.from(this.remoteKey, 'hex')
      this.drive = new Hyperdrive(this.store, keyBuffer)
      this.emit('status', 'Joining existing workspace...')
    } else if (this.ownKey) {
      // Reopening our own drive (we are still the writer)
      const keyBuffer = b4a.from(this.ownKey, 'hex')
      this.drive = new Hyperdrive(this.store, keyBuffer)
      this.emit('status', 'Opening workspace...')
    } else {
      // Creating new drive (we are the writer)
      this.drive = new Hyperdrive(this.store)
      this.emit('status', 'Creating new workspace...')
    }
    
    await this.drive.ready()
    
    // Create local drive interface
    this.local = new Localdrive(this.localPath)
    
    // Set up hyperswarm for peer discovery
    this.swarm = new Hyperswarm()
    
    // Handle peer connections
    this.swarm.on('connection', (socket, info) => {
      this.peerCount++
      this._reconnectAttempts = 0  // Reset on successful connection
      
      const peerId = info.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 8) : 'unknown'
      this.emit('peer-join', { peerId, total: this.peerCount })
      
      // Replicate the corestore (handles all hypercores)
      this.store.replicate(socket)
      
      socket.on('close', () => {
        this.peerCount--
        this.emit('peer-leave', { peerId, total: this.peerCount })
      })
      
      socket.on('error', (err) => {
        this.emit('error', { type: 'connection', peerId, error: err.message })
      })
    })
    
    // Join the swarm with the drive's discovery key
    const discovery = this.swarm.join(this.drive.discoveryKey, {
      server: this.isWriter,  // Writer announces as server
      client: true            // Everyone looks for peers
    })
    
    // Wait for initial DHT announcement
    await discovery.flushed()
    this.emit('status', 'Connected to network')
    
    this.ready = true
    
    return b4a.toString(this.drive.key, 'hex')
  }
  
  /**
   * Check if a path should be ignored
   */
  shouldIgnore(filePath) {
    const basename = path.basename(filePath)
    const parts = filePath.split(path.sep)
    
    for (const pattern of this.ignorePatterns) {
      // Direct match
      if (basename === pattern) return true
      
      // Check if any path component matches
      if (parts.includes(pattern)) return true
      
      // Glob-style patterns (simple * matching)
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
        if (regex.test(basename)) return true
      }
    }
    
    return false
  }
  
  /**
   * Filter function for mirroring
   */
  filterPath = (key) => {
    return !this.shouldIgnore(key)
  }
  
  /**
   * Sync local files to the remote hyperdrive
   * Only works if we are the writer
   */
  async syncToRemote() {
    if (!this.isWriter) {
      this.emit('error', { type: 'sync', error: 'Cannot write to remote drive (read-only)' })
      return null
    }
    
    if (!this.ready) {
      this.emit('error', { type: 'sync', error: 'Not initialized' })
      return null
    }
    
    this.emit('sync-start', { direction: 'local→remote' })
    
    try {
      const mirror = this.local.mirror(this.drive, {
        filter: this.filterPath,
        prune: this.syncDeletes  // Remove files from remote that don't exist locally
      })
      
      await mirror.done()
      
      const stats = {
        direction: 'local→remote',
        count: mirror.count
      }
      
      this.emit('sync-complete', stats)
      return stats
    } catch (err) {
      this.emit('error', { type: 'sync', direction: 'local→remote', error: err.message })
      throw err
    }
  }
  
  /**
   * Sync remote hyperdrive files to local
   */
  async syncToLocal() {
    if (!this.ready) {
      this.emit('error', { type: 'sync', error: 'Not initialized' })
      return null
    }
    
    this.emit('sync-start', { direction: 'remote→local' })
    
    try {
      // First, update our view of the remote drive
      await this.drive.update()
      
      const mirror = this.drive.mirror(this.local, {
        filter: this.filterPath,
        prune: this.syncDeletes  // Delete local files not in remote if enabled
      })
      
      await mirror.done()
      
      const stats = {
        direction: 'remote→local',
        count: mirror.count
      }
      
      this.emit('sync-complete', stats)
      return stats
    } catch (err) {
      this.emit('error', { type: 'sync', direction: 'remote→local', error: err.message })
      throw err
    }
  }
  
  /**
   * Start watching for changes
   * @param {number} pollInterval - Polling interval in ms (default: 3000)
   */
  async startWatching(pollInterval = 3000) {
    if (this.watching) return
    this.watching = true
    
    this.emit('watch-start')
    
    if (this.isWriter) {
      // Watch local filesystem and sync to remote
      this._startLocalWatch(pollInterval)
    }
    
    // Watch remote drive for changes (append events)
    this.drive.core.on('append', () => {
      if (!this.isWriter) {
        this._syncToLocal()
      }
    })
    
    // Also periodically check for updates from peers
    this._updateInterval = setInterval(async () => {
      try {
        await this.drive.update()
        if (!this.isWriter) {
          await this._syncToLocal()
        }
      } catch (err) {
        // Ignore update errors, will retry
      }
    }, pollInterval)
  }
  
  /**
   * Watch local filesystem for changes
   */
  async _startLocalWatch(pollInterval) {
    if (!this.isWriter) return
    
    // Try native watch first, fall back to polling
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
  }
  
  /**
   * Stop watching for changes
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
   * List files in the remote drive
   */
  async listRemote(dirPath = '/') {
    const files = []
    
    for await (const entry of this.drive.list(dirPath)) {
      files.push({
        path: entry.key,
        size: entry.value?.blob?.byteLength || 0
      })
    }
    
    return files
  }
  
  /**
   * Get drive info
   */
  async getInfo() {
    await this.drive.update()
    
    const files = await this.listRemote()
    const totalSize = files.reduce((sum, f) => sum + f.size, 0)
    
    return {
      key: b4a.toString(this.drive.key, 'hex'),
      discoveryKey: b4a.toString(this.drive.discoveryKey, 'hex'),
      version: this.drive.version,
      isWriter: this.isWriter,
      fileCount: files.length,
      totalSize,
      peers: this.peerCount
    }
  }
  
  /**
   * Clean shutdown
   */
  async close() {
    this.emit('status', 'Shutting down...')
    
    this.stopWatching()
    
    if (this.swarm) {
      await this.swarm.destroy()
    }
    
    if (this.store) {
      await this.store.close()
    }
    
    this.ready = false
    this.emit('close')
  }
}
