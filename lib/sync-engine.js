import Localdrive from 'localdrive'
import Hyperbee from 'hyperbee'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'

class SyncEngine {
  constructor (dir, autobase) {
    this.dir = dir
    this.autobase = autobase
    this.drive = null
    this._ready = false
  }

  async ready () {
    if (this._ready) return

    this.drive = new Localdrive(this.dir)
    await this.drive.ready()

    this._ready = true
  }

  async pushFile (relativePath) {
    const fullPath = path.join(this.dir, relativePath)

    // Read file stats
    const stats = await fs.stat(fullPath)

    // Stream file content to Hyperblobs
    const content = await fs.readFile(fullPath)
    const blobId = await this.autobase.putBlob(content)

    // Calculate hash
    const hash = crypto.createHash('sha256').update(content).digest('hex')

    // Store metadata in Autobase
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

    // Update view
    await this.autobase.base.view.update()
  }

  async pushDelete (relativePath) {
    await this.autobase.append({
      type: 'del',
      key: relativePath
    })

    await this.autobase.base.view.update()
  }

  async pullFile (relativePath) {
    // Get metadata from Autobase
    const bee = new Hyperbee(this.autobase.base.view, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })

    const entry = await bee.get(relativePath)
    if (!entry) {
      throw new Error(`File not found: ${relativePath}`)
    }

    const metadata = entry.value

    // Get content from Hyperblobs
    const content = await this.autobase.getBlob(metadata.blobId)

    // Write to local filesystem
    const fullPath = path.join(this.dir, relativePath)

    // Ensure parent directory exists
    const parentDir = path.dirname(fullPath)
    await fs.mkdir(parentDir, { recursive: true })

    // Write file
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

  async pullDelete (relativePath) {
    const fullPath = path.join(this.dir, relativePath)

    try {
      await fs.unlink(fullPath)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err
      }
      // File doesn't exist, that's ok
    }
  }

  async needsSync (relativePath) {
    const fullPath = path.join(this.dir, relativePath)

    // Get local file metadata
    let localStats
    try {
      localStats = await fs.stat(fullPath)
    } catch (err) {
      if (err.code === 'ENOENT') {
        // File doesn't exist locally, needs sync if exists remotely
        return true
      }
      throw err
    }

    // Get remote metadata
    const bee = new Hyperbee(this.autobase.base.view, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })

    const entry = await bee.get(relativePath)
    if (!entry) {
      // File doesn't exist remotely, needs sync
      return true
    }

    const remoteMetadata = entry.value

    // Compare mtime first (fast check)
    if (Math.abs(localStats.mtimeMs - remoteMetadata.mtime) > 1000) {
      // More than 1 second difference, needs sync
      return true
    }

    // Compare hash (accurate check)
    const content = await fs.readFile(fullPath)
    const hash = crypto.createHash('sha256').update(content).digest('hex')

    if (hash !== remoteMetadata.hash) {
      return true
    }

    return false
  }

  async close () {
    if (this.drive) {
      await this.drive.close()
    }
  }
}

export { SyncEngine }
