import chokidar from 'chokidar'
import { EventEmitter } from 'events'
import { IgnoreParser } from './ignore.js'
import path from 'path'

class FSWatcher extends EventEmitter {
  constructor (dir, options = {}) {
    super()
    this.dir = dir
    this.options = options
    this.watcher = null
    this.ignoreParser = null
    this._ready = false
  }

  async ready () {
    if (this._ready) return

    // Load ignore patterns
    const ignoreFilePath = path.join(this.dir, '.pearsyncignore')
    this.ignoreParser = new IgnoreParser(ignoreFilePath)
    await this.ignoreParser.load()

    // Create chokidar watcher
    this.watcher = chokidar.watch(this.dir, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50
      },
      ignored: (filePath) => {
        // Get relative path
        const relativePath = path.relative(this.dir, filePath)

        // Don't ignore the root directory
        if (relativePath === '') return false

        // Ignore .pearsyncignore file itself
        if (relativePath === '.pearsyncignore') return true

        // Check against ignore patterns
        return this.ignoreParser.ignores(relativePath)
      }
    })

    // Forward events
    this.watcher
      .on('add', (filePath) => this._handleEvent('add', filePath))
      .on('change', (filePath) => this._handleEvent('change', filePath))
      .on('unlink', (filePath) => this._handleEvent('unlink', filePath))
      .on('addDir', (filePath) => this._handleEvent('addDir', filePath))
      .on('unlinkDir', (filePath) => this._handleEvent('unlinkDir', filePath))
      .on('error', (error) => this.emit('error', error))

    // Wait for ready
    await new Promise((resolve) => {
      this.watcher.on('ready', resolve)
    })

    this._ready = true
  }

  _handleEvent (type, filePath) {
    const relativePath = path.relative(this.dir, filePath)

    this.emit('change', {
      type,
      path: relativePath
    })
  }

  async close () {
    if (this.watcher) {
      await this.watcher.close()
    }
  }
}

export { FSWatcher }
